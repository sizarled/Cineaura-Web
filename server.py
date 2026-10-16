#!/usr/bin/env python3
from http.server import ThreadingHTTPServer, SimpleHTTPRequestHandler
from urllib.parse import urlparse, parse_qs, urljoin, unquote, quote
import base64
import calendar
import collections
import hashlib
import http.client
import io
import html as html_module
import ipaddress
import json
import lzma
import os
import re
import ssl
import threading
import time
import socket
import sys
import unicodedata
import urllib.error
import urllib.request
import xml.etree.ElementTree as ET
import zlib

ROOT = os.path.dirname(os.path.abspath(__file__))
os.chdir(ROOT)

ROUTES = {
    "/": "index.html",
    "/watch": "watch.html",
    "/watch.html": "watch.html",
    "/Cast.html": "Cast.html",
    "/cast.html": "Cast.html",
    "/cast": "Cast.html",
    "/register": "register.html",
    "/signup": "register.html",
    "/SignUp": "register.html",
    "/login": "login.html",
    "/Rest": "Rest.html",
    "/rest": "Rest.html",
    "/Rest.html": "Rest.html",
    "/dashboard": "dashboard.html",
    "/Profile": "Profile.html",
    "/Profile.html": "Profile.html",
    "/Playlist.html": "Playlist.html",
    "/activate": "activate.html",
    "/Listchannels.html": "Listchannels.html",
    "/Listchannels": "Listchannels.html",
    "/Playlist": "Playlist.html",
    "/Panel": "Panel.html",
    "/Prize": "prize.html",
    "/Prize.html": "prize.html",
    "/Prizes": "prize.html",
    "/privacy": "privacy.html",
    "/privacy.html": "privacy.html",
    "/terms": "terms.html",
    "/terms.html": "terms.html",
    "/support": "support.html",
    "/support.html": "support.html",
    "/contact": "support.html",
    "/help": "support.html",
    "/about": "about.html",
    "/about.html": "about.html",
}


def resolve_clean_url(path):
    """Serve /name (no extension) from name.html, case-insensitive.

    Shared links are written by hand as often as they are generated, so a
    differently cased page name (/profile.html for Profile.html) resolves too —
    file names are case-sensitive on Linux.
    """
    name = path.strip("/")
    if not name or "/" in name:
        return None
    if "." in name:
        if os.path.exists(os.path.join(ROOT, name)) or not name.lower().endswith(".html"):
            return None
        for f in os.listdir(ROOT):
            if f.lower() == name.lower():
                return f
        return None
    for f in os.listdir(ROOT):
        if f.lower() == name.lower() + ".html":
            return f
    return None


MAX_M3U_BYTES = 40 * 1024 * 1024


MAX_PAGE_BYTES = 512 * 1024
META_RE = re.compile(r"<meta\b[^>]*>", re.I)
CONTENT_RE = re.compile(r"""content\s*=\s*(?:"([^"]*)"|'([^']*)')""", re.I)
NAME_RE = re.compile(r"""(?:property|name)\s*=\s*(?:"([^"]*)"|'([^']*)')""", re.I)

_thumb_cache = {}


def _meta_value(tag, wanted):
    """content= of a <meta> whose property/name is one of `wanted`."""
    m = NAME_RE.search(tag)
    if not m or (m.group(1) or m.group(2) or "").lower() not in wanted:
        return ""
    c = CONTENT_RE.search(tag)
    if not c:
        return ""
    return html_module.unescape((c.group(1) or c.group(2) or "")).strip()


def read_page_meta(url):
    """Fetch the head of a watch page and return its thumbnail and site name.

    The browser cannot do this itself: the hosts do not send CORS headers, so
    the page is read here and only the two <meta> values come back.
    """
    if not is_public_http_url(url):
        raise ValueError("blocked")
    req = urllib.request.Request(
        url,
        headers={
            "User-Agent": "Mozilla/5.0 (compatible; CineAura-Thumb/1.0)",
            "Accept": "text/html,application/xhtml+xml",
        },
    )
    with urllib.request.urlopen(req, timeout=8) as resp:
        ctype = (resp.headers.get("Content-Type") or "").lower()
        if "html" not in ctype and "text" not in ctype:
            raise ValueError("not html")
        raw = resp.read(MAX_PAGE_BYTES)
    charset = "utf-8"
    m = re.search(rb"charset=[\"\']?([a-zA-Z0-9_\-]+)", raw[:4096])
    if m:
        charset = m.group(1).decode("ascii", "ignore") or "utf-8"
    text = raw.decode(charset, "ignore")
    image = ""
    name = ""
    for tag in META_RE.findall(text):
        if not image:
            image = _meta_value(tag, {"og:image", "og:image:secure_url", "og:image:url", "twitter:image"})
        if not name:
            name = _meta_value(tag, {"og:site_name", "twitter:site"})
        if image and name:
            break
    if image:
        image = urljoin(url, image)
        if not image.startswith(("http://", "https://")) or not is_public_http_url(image):
            image = ""
    return {"image": image, "name": name[:60]}


TMDB_SITE = "https://www.themoviedb.org"
PROVIDER_TTL = 6 * 3600
MAX_OTT_BYTES = 3 * 1024 * 1024
OTT_QUALITIES = ("4k", "hd", "sd")

_provider_cache = {}

_TAG_RE = re.compile(r"<[^>]+>")
_SECTION_SPLIT_RE = re.compile(r'<div class="ott_provider"', re.I)
_H3_RE = re.compile(r"<h3>\s*(.*?)\s*</h3>", re.I | re.S)
_LI_RE = re.compile(r"<li\b([^>]*)>(.*?)</li>", re.I | re.S)
_A_RE = re.compile(r"<a\b([^>]*)>", re.I)
_IMG_RE = re.compile(r'<img[^>]+src="([^"]+)"', re.I)
_ATTR_RE = re.compile(r"""([a-zA-Z_:][-a-zA-Z0-9_:.]*)\s*=\s*("([^"]*)"|'([^']*)')""")
_WRAPPER_RE = re.compile(r'<span class="wrapper ([a-z_]+)"', re.I)
_PRICE_RE = re.compile(r'<span class="price">\s*(.*?)\s*</span>', re.I | re.S)
_PRES_RE = re.compile(r'<span class="presentation_type">\s*(.*?)\s*</span>', re.I | re.S)
_FILTER_RE = re.compile(r'data-panel="(ott_filter_[a-z0-9_]+)"[^>]*>\s*([^<]*?)\s*<', re.I)
_SUMMARY_RE = re.compile(r'<div class="ott_title">.*?</div>\s*<p>(.*?)</p>', re.I | re.S)
_JUSTWATCH_RE = re.compile(r'<a href="(https://www\.justwatch\.com/[^"]+)"', re.I)
_UCT_COUNTRY_RE = re.compile(r"uct_country=([a-zA-Z]{2})")
_CX_RE = re.compile(r"click\.justwatch\.com/a\?cx=([^&\"']+)")
_DEST_RE = re.compile(r"[?&]r=([^&\"']+)")

# TMDB writes the section headings in English whatever the page language is.
KIND_BY_HEADING = {
    "stream": "flatrate",
    "flatrate": "flatrate",
    "subscription": "flatrate",
    "rent": "rent",
    "buy": "buy",
    "purchase": "buy",
    "free": "free",
    "ads": "ads",
    "cinema": "cinema",
    "theatrical": "cinema",
}


def _attrs(raw):
    out = {}
    for m in _ATTR_RE.finditer(raw or ""):
        out[m.group(1).lower()] = html_module.unescape(m.group(3) if m.group(3) is not None else m.group(4) or "")
    return out


def _text(fragment):
    return html_module.unescape(_TAG_RE.sub("", fragment or "")).strip()


def destination_url(href):
    """The link behind JustWatch's clickout: what the visitor should land on."""
    m = _DEST_RE.search(href or "")
    if not m:
        return ""
    target = unquote(m.group(1))
    # affiliate wrappers keep the real address in their own `u` parameter
    inner = re.search(r"[?&]u=([^&]+)", target)
    if inner:
        candidate = unquote(inner.group(1))
        if candidate.startswith("http"):
            return candidate
    return target if target.startswith("http") else ""


def decode_clickout(href):
    """JustWatch hides the machine-readable offer in the `cx` query parameter."""
    m = _CX_RE.search(href or "")
    if not m:
        return {}
    raw = unquote(m.group(1)).replace("-", "+").replace("_", "/")
    raw += "=" * (-len(raw) % 4)
    try:
        payload = json.loads(base64.b64decode(raw).decode("utf-8", "ignore"))
    except Exception:
        return {}
    offer = {}
    for block in payload.get("data") or []:
        data = block.get("data") or {}
        if "monetizationType" in data or "presentationType" in data:
            offer = data
    return offer


def _quality_from_classes(classes):
    for name in OTT_QUALITIES:
        if "ott_filter_%s" % name in classes:
            return name.upper() if name != "4k" else "4K"
    return ""


def parse_ott_fragment(html_text, region=""):
    """Read TMDB's offers window into one list of offers plus the filter tabs."""
    text = html_text or ""
    chunks = _SECTION_SPLIT_RE.split(text)[1:]
    offers = []
    headings = []
    for chunk in chunks:
        heading = _text(_H3_RE.search(chunk).group(1)) if _H3_RE.search(chunk) else ""
        section_kind = KIND_BY_HEADING.get(heading.lower(), "")
        if heading:
            headings.append(heading)
        for li in _LI_RE.finditer(chunk):
            classes = (li.group(1) or "").lower()
            body = li.group(2) or ""
            anchor = _A_RE.search(body)
            attrs = _attrs(anchor.group(1)) if anchor else {}
            href = attrs.get("href", "")
            title = attrs.get("title", "")
            clickout = decode_clickout(href)
            logo = _IMG_RE.search(body)
            wrapper = _WRAPPER_RE.search(body)
            kind = (clickout.get("monetizationType") or (wrapper.group(1) if wrapper else "") or section_kind).lower()
            if kind not in ("flatrate", "rent", "buy", "free", "ads", "cinema"):
                kind = section_kind or kind
            price_text = _text(_PRICE_RE.search(body).group(1)) if _PRICE_RE.search(body) else ""
            pres_text = _text(_PRES_RE.search(body).group(1)) if _PRES_RE.search(body) else ""
            presentation = str(clickout.get("presentationType") or "").lower()
            quality = (presentation.upper() if presentation == "4k" else presentation.upper()) \
                or _quality_from_classes(classes) or pres_text.upper()
            provider = str(clickout.get("provider") or "").strip()
            if not provider:
                # title="Buy Free Guy on Naver Store"
                parts = title.rsplit(" on ", 1)
                provider = parts[1].strip() if len(parts) == 2 else title.strip()
            if not provider:
                continue
            country = _UCT_COUNTRY_RE.search(href)
            price = clickout.get("price")
            offers.append({
                "provider": provider,
                "provider_id": clickout.get("providerId") or None,
                "kind": kind,
                "quality": quality,
                "price": price if isinstance(price, (int, float)) else None,
                "price_text": price_text,
                "currency": str(clickout.get("currency") or ""),
                "audio": str(clickout.get("audioLanguage") or ""),
                "subtitles": str(clickout.get("subtitleLanguage") or ""),
                "best_price": "ott_filter_best_price" in classes,
                "logo": ("https://image.tmdb.org" + logo.group(1)) if logo and logo.group(1).startswith("/") else (logo.group(1) if logo else ""),
                "url": destination_url(href),
                "region": (country.group(1).upper() if country else region),
            })

    filters = []
    for m in _FILTER_RE.finditer(text):
        panel, label = m.group(1), _text(m.group(2))
        if panel == "ott_filter_best_price":
            filters.append({"id": "best_price", "label": label or "Best Price"})
            continue
        for name in OTT_QUALITIES:
            if panel == "ott_filter_%s" % name:
                filters.append({"id": name, "label": label or name.upper()})
    summary = _SUMMARY_RE.search(text)
    justwatch = _JUSTWATCH_RE.search(text)
    qualities = []
    for offer in offers:
        if offer["quality"] and offer["quality"] not in qualities:
            qualities.append(offer["quality"])
    ordered = [q for q in ("4K", "HD", "SD") if q in qualities] + [q for q in qualities if q not in ("4K", "HD", "SD")]
    currency = next((o["currency"] for o in offers if o["currency"]), "")
    return {
        "region": (offers[0]["region"] if offers else region) or "",
        "currency": currency,
        "qualities": ordered,
        "filters": filters,
        "sections": headings,
        "summary": _text(summary.group(1)) if summary else "",
        "justwatch": justwatch.group(1) if justwatch else "",
        "offers": offers,
    }


def group_providers(parsed):
    """One card per platform, its offers ordered by kind then quality."""
    kind_rank = {"flatrate": 0, "free": 1, "ads": 2, "rent": 3, "buy": 4, "cinema": 5}
    quality_rank = {"4K": 3, "HD": 2, "SD": 1, "": 0}
    grouped = {}
    for offer in parsed.get("offers") or []:
        key = offer.get("provider_id") or offer["provider"].lower()
        card = grouped.get(key)
        if not card:
            card = {
                "provider_id": offer.get("provider_id"),
                "name": offer["provider"],
                "logo": offer.get("logo") or "",
                "offers": [],
            }
            grouped[key] = card
        if offer.get("logo") and not card["logo"]:
            card["logo"] = offer["logo"]
        card["offers"].append(offer)
    for card in grouped.values():
        card["offers"].sort(
            key=lambda o: (kind_rank.get(o["kind"], 9), -quality_rank.get(o["quality"], 0), o.get("price") or 0)
        )
        # keep the payload small: the card already carries name, id and logo
        card["offers"] = [
            {k: o[k] for k in ("kind", "quality", "price", "price_text", "currency",
                               "audio", "subtitles", "best_price", "url")}
            for o in card["offers"]
        ]
        card["kinds"] = sorted({o["kind"] for o in card["offers"]}, key=lambda k: kind_rank.get(k, 9))
        card["qualities"] = [q for q in ("4K", "HD", "SD") if any(o["quality"] == q for o in card["offers"])]
        prices = [o["price"] for o in card["offers"] if isinstance(o.get("price"), (int, float)) and o["price"] > 0]
        card["from_price"] = min(prices) if prices else None
        card["from_price_text"] = next(
            (o["price_text"] for o in sorted(card["offers"], key=lambda o: o.get("price") or 0)
             if o.get("price_text") and (o.get("price") or 0) > 0),
            "",
        )
    return sorted(grouped.values(), key=lambda c: (c["from_price"] is None, c["from_price"] or 0, c["name"].lower()))


def fetch_ott_page(media, tmdb_id, region):
    """The offers fragment first; the whole watch page if TMDB moved it."""
    # Development hook: CINEAURA_OTT_FIXTURE=/path/to/saved-watch-page.html lets the
    # parser be exercised without a route to themoviedb.org.
    fixture = os.environ.get("CINEAURA_OTT_FIXTURE", "")
    if fixture and os.path.isfile(fixture):
        return io.open(fixture, encoding="utf-8", errors="ignore").read(), "fixture:%s" % fixture
    media = "tv" if media == "tv" else "movie"
    locale = (region or "US").upper()[:2]
    urls = [
        "%s/%s/%s/remote/watch?translate=false&locale=%s" % (TMDB_SITE, media, tmdb_id, locale),
        "%s/%s/%s/watch?locale=%s" % (TMDB_SITE, media, tmdb_id, locale),
    ]
    last_error = ""
    for url in urls:
        if not is_public_http_url(url):
            continue
        try:
            req = urllib.request.Request(url, headers={
                "User-Agent": "Mozilla/5.0 (compatible; CineAura/1.0; +https://cineaura.app)",
                "Accept": "text/html,application/xhtml+xml",
                "Accept-Language": "en",
                "X-Requested-With": "XMLHttpRequest",
            })
            with urllib.request.urlopen(req, timeout=12) as resp:
                if resp.headers.get("Content-Type", "").lower().startswith("application/json"):
                    continue
                raw = resp.read(MAX_OTT_BYTES)
            if b"ott_provider" in raw or b"ott_offers_window" in raw:
                return raw.decode("utf-8", "ignore"), url
            last_error = "no offers in %s" % url
        except Exception as error:
            last_error = "%s: %s" % (url, error)
    raise ValueError(last_error or "unavailable")


def providers_for(media, tmdb_id, region):
    """Cached price/quality lookup; a failure simply yields no offers."""
    key = "%s:%s:%s" % (media, tmdb_id, (region or "US").upper())
    now = time.time()
    hit = _provider_cache.get(key)
    if hit and now - hit[0] < PROVIDER_TTL:
        payload = dict(hit[1])
        payload["cached"] = True
        return payload
    payload = {
        "media": media,
        "tmdb_id": str(tmdb_id),
        "region": (region or "US").upper(),
        "currency": "",
        "qualities": [],
        "filters": [],
        "sections": [],
        "summary": "",
        "justwatch": "",
        "providers": [],
        "offer_count": 0,
        "source": "tmdb_watch_page",
        "fetched_at": int(now),
        "ttl": PROVIDER_TTL,
        "cached": False,
    }
    try:
        html_text, _url = fetch_ott_page(media, tmdb_id, region)
        parsed = parse_ott_fragment(html_text, payload["region"])
        payload.update({
            "region": parsed["region"] or payload["region"],
            "currency": parsed["currency"],
            "qualities": parsed["qualities"],
            "filters": parsed["filters"],
            "sections": parsed["sections"],
            "summary": parsed["summary"],
            "justwatch": parsed["justwatch"],
            "offer_count": len(parsed["offers"]),
            "providers": group_providers(parsed),
        })
    except Exception as error:
        payload["source"] = "unavailable"
        payload["error"] = str(error)[:160]
    _provider_cache[key] = (now, payload)
    if len(_provider_cache) > 300:
        for stale in sorted(_provider_cache, key=lambda k: _provider_cache[k][0])[:120]:
            _provider_cache.pop(stale, None)
    return payload


def thumb_for(url):
    """Cached wrapper: an unreachable or shy host just yields empty values."""
    now = time.time()
    hit = _thumb_cache.get(url)
    if hit and now - hit[0] < 3600:
        return hit[1]
    try:
        payload = read_page_meta(url)
    except Exception:
        payload = {"image": "", "name": ""}
    _thumb_cache[url] = (now, payload)
    if len(_thumb_cache) > 500:
        for key in sorted(_thumb_cache, key=lambda k: _thumb_cache[k][0])[:200]:
            _thumb_cache.pop(key, None)
    return payload


DNS_TTL = 60  # seconds a host's checked addresses are remembered
_dns_cache = {}
_dns_lock = threading.Lock()


def _blocked_ip(ip):
    return ip.is_private or ip.is_loopback or ip.is_link_local or ip.is_reserved or ip.is_multicast or ip.is_unspecified


def public_addresses(host, port):
    """The addresses of `host` when every one of them is public, else None (SSRF guard).

    Remembered for a minute: a live channel asks for its playlist every few
    seconds and for a segment more often still, and each request used to cost a
    DNS lookup or two. The relay connects to exactly these addresses, so a
    second, different DNS answer cannot steer it to a private one.
    """
    key = (host.lower(), port)
    now = time.monotonic()
    with _dns_lock:
        hit = _dns_cache.get(key)
        if hit and hit[0] > now:
            return hit[1]
    addrs = None
    try:
        infos = socket.getaddrinfo(host, port, 0, socket.SOCK_STREAM)
    except (OSError, UnicodeError):
        infos = []
    if infos:
        addrs = []
        for family, _type, _proto, _name, sockaddr in infos:
            try:
                ip = ipaddress.ip_address(str(sockaddr[0]).split("%")[0])
            except ValueError:
                addrs = None
                break
            if _blocked_ip(ip):
                addrs = None
                break
            if (family, sockaddr) not in addrs:
                addrs.append((family, sockaddr))
    with _dns_lock:
        _dns_cache[key] = (now + (DNS_TTL if addrs else 10), addrs)
        if len(_dns_cache) > 2048:
            for old in [k for k, v in _dns_cache.items() if v[0] <= now] or list(_dns_cache)[:1024]:
                _dns_cache.pop(old, None)
    return addrs


def is_public_http_url(url):
    """Allow only http(s) URLs that resolve to public addresses (SSRF guard)."""
    p = urlparse(url)
    if p.scheme not in ("http", "https") or not p.hostname:
        return False
    try:
        port = p.port or (443 if p.scheme == "https" else 80)
    except ValueError:
        return False
    return public_addresses(p.hostname, port) is not None


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        return None


def fetch_m3u(url):
    opener = urllib.request.build_opener(_NoRedirect)
    for _ in range(4):
        if not is_public_http_url(url):
            raise ValueError("blocked")
        req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0 CineAura-M3U"})
        try:
            with opener.open(req, timeout=25) as resp:
                data = resp.read(MAX_M3U_BYTES + 1)
                if len(data) > MAX_M3U_BYTES:
                    raise ValueError("too large")
                return data
        except urllib.error.HTTPError as err:
            if err.code in (301, 302, 303, 307, 308) and err.headers.get("Location"):
                url = urljoin(url, err.headers["Location"])
                continue
            raise
    raise ValueError("too many redirects")


# ---------- /api/stream: same-origin relay for the IPTV channel player ----------
# The site is served over https while most IPTV servers speak plain http and send
# no CORS headers, so the browser refuses to play them directly. The player on
# Listchannels.html tries a stream directly first and falls back to this relay.
# Only media passes: HLS playlists (rewritten so every variant, segment and key
# comes back through here), MPEG-TS and other audio/video. Web pages, scripts,
# JSON or images are refused, so the relay cannot be used to fetch other sites.

STREAM_TIMEOUT = 20
STREAM_CHUNK = 64 * 1024
MAX_HLS_PLAYLIST = 4 * 1024 * 1024
STREAM_MEDIA_TYPES = (
    "application/octet-stream",
    "binary/octet-stream",
    "application/mp2t",
    "application/x-mpegts",
    "application/mp4",
    "application/x-flv",
    "application/ogg",
)
_HLS_URI_RE = re.compile(r'URI="([^"]*)"')


def stream_relay_url(url):
    """Address of `url` through the relay (relative, so it stays same-origin)."""
    if not url.startswith(("http://", "https://")):
        return url  # data: URIs and DRM key schemes stay as they are
    return "/api/stream?url=" + quote(url, safe="")


def _tag_int(line, default=0):
    try:
        return int(line.split(":", 1)[1].strip())
    except (IndexError, ValueError):
        return default


def rewrite_hls(text, base, live=""):
    """Point every URI of an HLS playlist (variants, segments, keys, maps) at the relay.

    `live`: the id of a live window (see LiveWindows). Its segments then also
    carry their media sequence number, so that the relay can keep and share
    them — even when a server reuses segment names in a loop.
    """
    out = []
    seq = 0
    for line in text.splitlines():
        s = line.strip()
        if not s:
            continue
        if s.startswith("#"):
            if s.upper().startswith("#EXT-X-MEDIA-SEQUENCE:"):
                seq = _tag_int(s)
            if 'URI="' in s:
                s = _HLS_URI_RE.sub(lambda m: 'URI="%s"' % stream_relay_url(urljoin(base, m.group(1))), s)
            out.append(s)
        else:
            relayed = stream_relay_url(urljoin(base, s))
            if live and relayed.startswith("/api/stream?"):
                relayed += "&seq=%d&live=%s" % (seq, live)
            out.append(relayed)
            seq += 1
    return "\n".join(out) + "\n"


def parse_live_playlist(text, base):
    """(target duration, [(media sequence, absolute url, duration)]) of a live media playlist.

    None for anything else: a master playlist, a finished (VOD) one, or one with
    byte ranges, whose segments share a single address.
    """
    target = 0.0
    seq = 0
    duration = None
    segments = []
    for line in text.splitlines():
        s = line.strip()
        if not s:
            continue
        if s.startswith("#"):
            tag = s.upper()
            if tag.startswith(("#EXT-X-ENDLIST", "#EXT-X-BYTERANGE", "#EXT-X-STREAM-INF", "#EXT-X-PLAYLIST-TYPE:VOD")):
                return None
            if tag.startswith("#EXT-X-MEDIA-SEQUENCE:"):
                seq = _tag_int(s)
            elif tag.startswith("#EXT-X-TARGETDURATION:"):
                target = float(_tag_int(s))
            elif tag.startswith("#EXTINF:"):
                try:
                    duration = float(s[8:].split(",", 1)[0].strip())
                except ValueError:
                    duration = 0.0
            continue
        if not s.startswith("data:"):
            segments.append((seq, urljoin(base, s), duration if duration and duration > 0 else 0.0))
        seq += 1
        duration = None
    if not segments:
        return None
    if target <= 0:
        target = max(d for _s, _u, d in segments) or 6.0
    return target, [(n, u, d or target) for n, u, d in segments]


def is_hls_playlist(content_type, head):
    return "mpegurl" in content_type or head.lstrip(b"\xef\xbb\xbf \t\r\n").startswith(b"#EXTM3U")


def is_relayable_media(content_type):
    if not content_type:
        return True  # unlabelled: answered as application/octet-stream + nosniff
    return content_type.startswith(("video/", "audio/")) or content_type in STREAM_MEDIA_TYPES


def looks_like_media(head):
    """Media behind a wrong label (some IPTV servers send segments as text/plain)."""
    if len(head) >= 189 and head[0] == 0x47 and head[188] == 0x47:
        return True  # MPEG-TS packets
    if head[4:8] in (b"ftyp", b"styp", b"moof", b"sidx", b"moov"):
        return True  # MP4 / fragmented MP4
    if head[:3] in (b"ID3", b"FLV") or head[:4] == b"\x1aE\xdf\xa3":
        return True  # ID3-tagged audio, FLV, WebM / Matroska
    return len(head) >= 2 and head[0] == 0xFF and (head[1] & 0xF6) == 0xF0  # AAC (ADTS)


# Upstream connections stay open between requests (HTTP keep-alive). A live
# channel asks the same IPTV server for its playlist and for a segment every few
# seconds; a new TCP (and TLS) connection for each request cost one or more round
# trips every time — time the player then lacked to keep its buffer filled.
UPSTREAM_IDLE = 15  # seconds an idle upstream connection is kept
UPSTREAM_IDLE_PER_HOST = 4
_tls_context = None


def _tls():
    global _tls_context
    if _tls_context is None:
        _tls_context = ssl.create_default_context()
    return _tls_context


def _connect_any(addrs, timeout):
    """A TCP connection to the first approved address that answers."""
    error = None
    for family, sockaddr in addrs[:3]:
        sock = socket.socket(family, socket.SOCK_STREAM)
        try:
            sock.settimeout(timeout)
            sock.connect(sockaddr)
            sock.setsockopt(socket.IPPROTO_TCP, socket.TCP_NODELAY, 1)
            return sock
        except OSError as err:
            error = err
            sock.close()
    raise error or OSError("no address to connect to")


class _GuardedHTTPConnection(http.client.HTTPConnection):
    """Connects to the addresses the SSRF guard checked, never to a second DNS answer."""

    def __init__(self, host, port, addrs, timeout):
        super().__init__(host, port, timeout=timeout)
        self.addrs = addrs

    def connect(self):
        self.sock = _connect_any(self.addrs, self.timeout)


class _GuardedHTTPSConnection(_GuardedHTTPConnection):
    default_port = 443

    def connect(self):
        super().connect()
        self.sock = _tls().wrap_socket(self.sock, server_hostname=self.host)


class UpstreamPool:
    """Idle keep-alive connections to IPTV servers, by (scheme, host, port)."""

    def __init__(self):
        self.lock = threading.Lock()
        self.idle = {}

    def take(self, key):
        now = time.monotonic()
        conn = None
        stale = []
        with self.lock:
            stack = self.idle.get(key) or []
            while stack:
                candidate, parked = stack.pop()
                if now - parked < UPSTREAM_IDLE and candidate.sock is not None:
                    conn = candidate
                    break
                stale.append(candidate)
            if not stack:
                self.idle.pop(key, None)
        for old in stale:
            old.close()
        return conn

    def park(self, key, conn):
        now = time.monotonic()
        stale = []
        with self.lock:
            stack = self.idle.setdefault(key, [])
            if len(stack) < UPSTREAM_IDLE_PER_HOST:
                stack.append((conn, now))
                conn = None
            if len(self.idle) > 256:
                for k in list(self.idle):
                    keep = [(c, at) for c, at in self.idle[k] if now - at < UPSTREAM_IDLE]
                    stale.extend(c for c, at in self.idle[k] if now - at >= UPSTREAM_IDLE)
                    if keep:
                        self.idle[k] = keep
                    else:
                        del self.idle[k]
        if conn is not None:
            stale.append(conn)
        for old in stale:
            old.close()


_upstream_pool = UpstreamPool()


class UpstreamResponse:
    """An upstream answer. Its connection returns to the pool once the body was read to the end."""

    def __init__(self, key, conn, resp, url):
        self._key = key
        self._conn = conn
        self._resp = resp
        self.url = url
        self.status = resp.status
        self.reason = resp.reason
        self.headers = resp.headers

    def read(self, amt=None):
        return self._resp.read(amt)

    def read1(self, n=-1):
        return self._resp.read1(n)

    def close(self):
        resp, conn = self._resp, self._conn
        if resp is None:
            return
        self._resp = self._conn = None
        # read1() leaves a Content-Length body "open" at its end, read() closes it
        finished = resp.isclosed() or (not resp.chunked and resp.length == 0)
        reusable = finished and not resp.will_close
        resp.close()
        if reusable:
            _upstream_pool.park(self._key, conn)
        else:
            conn.close()

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        self.close()


# a kept-alive connection the server closed meanwhile: retried once on a new one
_STALE_CONNECTION = (
    http.client.RemoteDisconnected,
    http.client.BadStatusLine,
    ConnectionResetError,
    ConnectionAbortedError,
    BrokenPipeError,
)


def upstream_get(url, headers, timeout):
    """GET `url` (whatever the status) over a kept-alive connection to an approved address."""
    p = urlparse(url)
    if p.scheme not in ("http", "https") or not p.hostname:
        raise PermissionError("blocked")
    try:
        port = p.port or (443 if p.scheme == "https" else 80)
    except ValueError:
        raise PermissionError("blocked")
    addrs = public_addresses(p.hostname, port)
    if not addrs:
        raise PermissionError("blocked")
    target = quote(p.path or "/", safe="/%:@!$&'()*+,;=-._~")
    if p.query:
        target += "?" + quote(p.query, safe="=&%:@!$'()*+,;/?-._~[]")
    key = (p.scheme, p.hostname.lower(), port)
    for attempt in (0, 1):
        conn = _upstream_pool.take(key) if attempt == 0 else None
        reused = conn is not None
        if reused:
            conn.timeout = timeout
            conn.sock.settimeout(timeout)
        else:
            cls = _GuardedHTTPSConnection if p.scheme == "https" else _GuardedHTTPConnection
            conn = cls(p.hostname, port, addrs, timeout)
        try:
            conn.request("GET", target, headers=headers)
            resp = conn.getresponse()
        except _STALE_CONNECTION:
            conn.close()
            if reused:
                continue
            raise
        except BaseException:
            conn.close()
            raise
        return UpstreamResponse(key, conn, resp, url)
    raise ConnectionError("the server closed the connection")


def _drain(resp, limit=65536):
    """Read the short body of a redirect or an error, so that its connection can be reused."""
    try:
        length = int(resp.headers.get("Content-Length") or -1)
        if 0 <= length <= limit:
            resp.read(length)
    except Exception:
        pass
    resp.close()


def open_stream(url, headers, timeout=STREAM_TIMEOUT):
    """Open an upstream stream, following redirects through the SSRF guard.

    Returns (response, final_url): relative URIs in a playlist are resolved
    against the address the playlist really came from (IPTV servers often
    redirect to a load balancer with a token). Error answers raise
    urllib.error.HTTPError, as they did when this went through urllib.
    """
    for _ in range(6):
        resp = upstream_get(url, headers, timeout)
        if resp.status in (301, 302, 303, 307, 308):
            location = resp.headers.get("Location")
            if not location:
                _drain(resp)
                raise urllib.error.HTTPError(url, resp.status, resp.reason, resp.headers, io.BytesIO())
            _drain(resp)
            url = urljoin(url, location)
            continue
        if resp.status >= 400:
            error = urllib.error.HTTPError(url, resp.status, resp.reason, resp.headers, io.BytesIO())
            _drain(resp)
            raise error
        return resp, url
    raise ValueError("too many redirects")


# ---------- /api/stream-check: does a channel answer right now? ----------
# "Check channels" on Listchannels.html asks once per channel. The server opens
# the stream as the relay would, reads only its first bytes and answers with a
# small JSON verdict, so a check costs almost no bandwidth. An HLS playlist is
# followed down to one variant and one media segment: a playlist alone proves
# little, because dead channels often keep serving it.

CHECK_TIMEOUT = 7  # seconds per connection or read
CHECK_BUDGET = 12  # seconds for the whole check of one link
CHECK_HEAD = 2048  # bytes read to recognise the media


class StreamCheckError(Exception):
    """The link answered, but not with something a player can use."""


def read_head(resp, want, deadline):
    """Read up to `want` bytes (less at the end of the body or of the time budget)."""
    buf = b""
    while len(buf) < want and time.monotonic() < deadline:
        chunk = resp.read1(min(STREAM_CHUNK, want - len(buf)))
        if not chunk:
            break
        buf += chunk
    return buf


def looks_like_text(head):
    """An error page or message rather than media (HTML, JSON, plain words)."""
    sample = head[:64].lstrip()
    if not sample:
        return True
    if sample[:1] in (b"<", b"{", b"["):
        return True
    return all(32 <= b < 127 or b in (9, 10, 13) for b in sample)


def hls_next(text, base):
    """One step down an HLS playlist: (url, is_variant, encrypted).

    A master playlist leads to its first variant; a media playlist to its newest
    segment (the oldest one of a live window may already be gone).
    """
    encrypted = False
    variant_next = False
    segments = []
    for line in text.splitlines():
        s = line.strip()
        if not s:
            continue
        if s.startswith("#EXT-X-STREAM-INF"):
            variant_next = True
        elif s.startswith("#EXT-X-KEY") and "METHOD=NONE" not in s.upper():
            encrypted = True
        elif not s.startswith("#"):
            if variant_next:
                return urljoin(base, s), True, False
            segments.append(s)
    if not segments:
        return "", False, encrypted
    return urljoin(base, segments[-1]), False, encrypted


def check_link(url, headers, deadline, depth=0):
    """Return the kind of media behind `url` ("media" or "hls"), or raise."""
    if time.monotonic() >= deadline:
        raise TimeoutError("check took too long")
    resp, final_url = open_stream(url, headers, timeout=CHECK_TIMEOUT)
    with resp:
        content_type = (resp.headers.get("Content-Type") or "").split(";")[0].strip().lower()
        head = read_head(resp, CHECK_HEAD, deadline)
        if not head:
            raise StreamCheckError("empty answer")
        if not is_hls_playlist(content_type, head):
            if looks_like_media(head):
                return "media"
            if is_relayable_media(content_type) and len(head) >= 188 and not looks_like_text(head):
                return "media"
            raise StreamCheckError("not media")
        if depth >= 3:
            raise StreamCheckError("playlist loop")
        raw = head + read_head(resp, MAX_HLS_PLAYLIST - len(head), deadline)
    text = raw.decode("utf-8", "replace").lstrip("\ufeff")
    nxt, is_variant, encrypted = hls_next(text, final_url)
    if not nxt:
        raise StreamCheckError("empty playlist")
    if is_variant:
        return check_link(nxt, headers, deadline, depth + 1)
    if time.monotonic() >= deadline:
        raise TimeoutError("check took too long")
    seg, _ = open_stream(nxt, headers, timeout=CHECK_TIMEOUT)
    with seg:
        content_type = (seg.headers.get("Content-Type") or "").split(";")[0].strip().lower()
        head = read_head(seg, CHECK_HEAD, deadline)
    if looks_like_media(head):
        return "hls"
    # AES-128 segments are encrypted bytes: nothing to recognise, only no error page
    if (encrypted or is_relayable_media(content_type)) and len(head) >= 16 and not looks_like_text(head):
        return "hls"
    raise StreamCheckError("segment is not media")


def check_stream(links, user_agent):
    """Verdict for one channel: its link, then its alternative (Xtream HLS)."""
    headers = {"User-Agent": user_agent or "Mozilla/5.0 CineAura-Player", "Accept": "*/*"}
    started = time.monotonic()
    verdict = {"ok": False, "error": "unreachable"}
    for n, link in enumerate(links):
        try:
            kind = check_link(link, headers, started + CHECK_BUDGET)
            verdict = {"ok": True, "kind": kind, "via": "alt" if n else "url"}
            break
        except PermissionError:
            verdict = {"ok": False, "error": "blocked"}
            break
        except urllib.error.HTTPError as err:
            verdict = {"ok": False, "error": "http %d" % err.code}
            err.close()  # an error answer: the alternative link may still work
        except StreamCheckError as err:
            verdict = {"ok": False, "error": str(err)}
        except (socket.timeout, TimeoutError):
            verdict = {"ok": False, "error": "timeout"}
            break  # the same server would keep us waiting again
        except urllib.error.URLError as err:
            timed_out = isinstance(err.reason, (socket.timeout, TimeoutError))
            verdict = {"ok": False, "error": "timeout" if timed_out else "unreachable"}
            break
        except Exception:
            verdict = {"ok": False, "error": "unreachable"}
            break
    verdict["ms"] = int((time.monotonic() - started) * 1000)
    return verdict


# ---------- live HLS: segments kept, shared and fetched ahead ----------
# hls.js loads one segment at a time and asks for the next only when the last
# one has arrived. Through the relay each of those requests also waited for the
# IPTV server to answer — often half a second or more — and on a slow server
# that wait ate the margin the player needed: the picture stopped at the end
# of every segment. So for live windows the relay now
#   * fetches the next segments while the viewer is still downloading the
#     current one (READ_AHEAD, one download at a time per viewer, so an
#     account allowed a single connection is not asked for more);
#   * hands out a segment while it is still arriving (one upstream download,
#     however many requests: a retry, or several viewers of one channel);
#   * keeps finished segments for SEGMENT_TTL seconds within SEGMENT_CACHE_MB.
# A segment that cannot be kept (too large, cache full, upstream error) is
# relayed directly, exactly as before. CINEAURA_SEGMENT_CACHE_MB=0 turns this
# off; CINEAURA_READ_AHEAD=0 keeps the sharing but fetches nothing ahead.


def _env_int(name, default):
    try:
        return max(0, int(os.environ.get(name, default)))
    except ValueError:
        return default


SEGMENT_CACHE_MB = _env_int("CINEAURA_SEGMENT_CACHE_MB", 96)
READ_AHEAD = _env_int("CINEAURA_READ_AHEAD", 2)
SEGMENT_MAX = 16 * 1024 * 1024  # a larger segment is relayed, never kept
SEGMENT_TTL = 90  # seconds a finished segment stays available
SEGMENT_FETCHERS = 12  # background downloads at once, every viewer together
LIVE_IDLE = 40  # seconds without a request before a live window is forgotten


def segment_key(url, seq):
    return "%d|%s" % (seq, url)


class CachedSegment:
    """One segment, complete or still arriving."""

    def __init__(self, key, url):
        self.key = key
        self.url = url
        self.cond = threading.Condition()
        self.chunks = []
        self.size = 0
        self.status = 200
        self.ctype = "application/octet-stream"
        self.length = -1  # Content-Length of the upstream answer, -1 if it gave none
        self.ready = False  # status and headers known; data may follow
        self.done = False  # the whole body arrived
        self.failed = ""  # why the download stopped
        self.used = time.monotonic()


class SegmentCache:
    def __init__(self, budget):
        self.budget = budget
        self.lock = threading.Lock()
        self.items = collections.OrderedDict()  # key -> CachedSegment, least recently used first
        self.bytes = 0
        self.fetchers = threading.BoundedSemaphore(SEGMENT_FETCHERS)

    def get(self, key, url, headers):
        """(segment, started here) for `key`; the download starts when it is not kept yet.

        (None, False) when no download can start (cache full, too many at
        once): the caller relays the segment itself.
        """
        now = time.monotonic()
        with self.lock:
            self._trim(now)
            seg = self.items.get(key)
            if seg is not None:
                seg.used = now
                self.items.move_to_end(key)
                return seg, False
            if self.bytes > self.budget or not self.fetchers.acquire(False):
                return None, False
            seg = CachedSegment(key, url)
            self.items[key] = seg
        try:
            threading.Thread(target=self._download, args=(seg, dict(headers)), daemon=True).start()
        except RuntimeError:  # the system has no thread left
            self.fetchers.release()
            self._fail(seg, "no thread")
            return None, False
        return seg, True

    def peek(self, key):
        with self.lock:
            return self.items.get(key)

    def _trim(self, now):
        """Forget expired segments, then the least recently used finished ones beyond the budget."""
        for key in [k for k, seg in self.items.items() if seg.done and now - seg.used > SEGMENT_TTL]:
            self._drop(key)
        if self.bytes > self.budget:
            for key in [k for k, seg in self.items.items() if seg.done]:
                if self.bytes <= self.budget * 0.8:
                    break
                self._drop(key)

    def _drop(self, key):
        seg = self.items.pop(key, None)
        if seg is not None:
            self.bytes -= seg.size

    def _fail(self, seg, why):
        with seg.cond:
            seg.failed = why or "failed"
            seg.cond.notify_all()
        with self.lock:
            if self.items.get(seg.key) is seg:
                self._drop(seg.key)

    def _download(self, seg, headers):
        try:
            resp, _final = open_stream(seg.url, headers)
            with resp:
                ctype = (resp.headers.get("Content-Type") or "").split(";")[0].strip().lower()
                try:
                    length = int(resp.headers.get("Content-Length") or -1)
                except ValueError:
                    length = -1
                if length > SEGMENT_MAX:
                    raise ValueError("segment too large to keep")
                head = resp.read1(STREAM_CHUNK)
                labelled = is_relayable_media(ctype)
                if not (labelled or looks_like_media(head) or length == 16):
                    raise ValueError("not media")
                with seg.cond:
                    seg.status = resp.status if resp.status in (200, 206) else 200
                    seg.ctype = (ctype if labelled else "") or "application/octet-stream"
                    seg.length = length
                    seg.ready = True
                    seg.cond.notify_all()
                chunk = head
                while chunk:
                    if seg.size + len(chunk) > SEGMENT_MAX:
                        raise ValueError("segment too large to keep")
                    with self.lock:
                        if self.items.get(seg.key) is seg:
                            self.bytes += len(chunk)
                    with seg.cond:
                        seg.chunks.append(chunk)
                        seg.size += len(chunk)
                        seg.cond.notify_all()
                    chunk = resp.read1(STREAM_CHUNK)
                if 0 <= length != seg.size:
                    raise ValueError("segment cut short")
            with seg.cond:
                seg.done = True
                seg.used = time.monotonic()
                seg.cond.notify_all()
        except urllib.error.HTTPError as err:
            err.close()
            self._fail(seg, "http %d" % err.code)
        except Exception as err:
            self._fail(seg, str(err) or err.__class__.__name__)
        finally:
            self.fetchers.release()


def live_id(url):
    """Id of the live window of a playlist address (the one the player asks for)."""
    return hashlib.sha1(url.encode("utf-8", "replace")).hexdigest()[:16]


def fetch_playlist(url, headers, timeout=STREAM_TIMEOUT):
    """(text, final url) of an HLS playlist; raises when the answer is not one."""
    resp, final_url = open_stream(url, headers, timeout)
    with resp:
        content_type = (resp.headers.get("Content-Type") or "").split(";")[0].strip().lower()
        head = resp.read1(STREAM_CHUNK)
        if not is_hls_playlist(content_type, head):
            raise ValueError("not a playlist")
        raw = head + resp.read(MAX_HLS_PLAYLIST + 1 - len(head))
    if len(raw) > MAX_HLS_PLAYLIST:
        raise ValueError("playlist too large")
    return raw.decode("utf-8", "replace").lstrip("\ufeff"), final_url


class LiveWindow:
    """What the relay knows of one live playlist and of the player reading it."""

    def __init__(self, sid, source):
        self.sid = sid
        self.source = source  # the address the player asks for
        self.final = source  # where it last came from (after redirects)
        self.urls = {}  # media sequence -> segment url, of the newest window
        self.order = []
        self.target = 6.0
        self.last_dur = 6.0
        self.headers = {}
        self.body = b""  # the relayed playlist, as the player receives it
        self.fetched = 0.0  # when `body` came from the IPTV server
        self.changed = 0.0  # when a new segment last appeared
        self.newest = -1
        self.seen = time.monotonic()  # the player's last request of any kind
        self.seg_seen = 0.0  # its last segment request
        self.wanted = None  # newest segment it asked for
        self.queue = collections.deque()
        self.queued = set()
        self.running = False  # a fetcher works on the queue
        self.polling = False  # a poller keeps the playlist current
        self.next_poll = 0.0
        self.poll_errors = 0
        self.ahead_on = True
        self.fetched_ahead = set()
        self.asked = set()
        self.unused = 0


class LiveWindows:
    """Read-ahead for live playlists.

    While a player plays a live window, a poller re-reads the playlist just
    after the next segment is due, and a fetcher downloads each new segment at
    once — usually before the player even knows it exists. The player's own
    playlist reloads are then answered from that fresh copy. One poller and
    one download at a time per window, so an IPTV account limited to one
    connection is not asked for more than the player itself would ask.
    """

    def __init__(self, cache, ahead):
        self.cache = cache
        self.ahead = ahead if cache is not None else 0
        self.lock = threading.Lock()
        self.items = {}

    @staticmethod
    def start_index(target, segments):
        """Where hls.js starts in a fresh window: 3 target durations from its live edge."""
        total = sum(d for _s, _u, d in segments)
        pos = max(0.0, min(total - 3 * target, total - target))
        t = 0.0
        for i, (_s, _u, d) in enumerate(segments):
            if t + d > pos + 0.001:
                return i
            t += d
        return max(0, len(segments) - 1)

    def _idle(self, win, now):
        return now - win.seen > max(10.0, 2.5 * win.target)

    def _update(self, win, target, segments, body, final, now):  # the caller holds self.lock
        win.target = target
        win.urls = {seq: url for seq, url, _d in segments}
        win.order = [seq for seq, _u, _d in segments]
        win.last_dur = segments[-1][2]
        win.final = final
        first = win.order[0]
        # read-ahead nobody asked for: a server that hands out new addresses on
        # every reload (a fresh token each time) gains nothing from it
        for n in [n for n in win.fetched_ahead if n < first]:
            win.fetched_ahead.discard(n)
            if n not in win.asked:
                win.unused += 1
        if win.unused >= 4:
            win.ahead_on = False
        win.asked = {n for n in win.asked if n >= first}
        win.queued = {n for n in win.queued if n >= first}
        if win.order[-1] > win.newest:
            win.newest = win.order[-1]
            win.changed = now
        win.body = body
        win.fetched = now

    def playlist(self, sid, source, final, target, segments, body, headers):
        """A player received a live window straight from the IPTV server."""
        if not self.ahead:
            return
        now = time.monotonic()
        with self.lock:
            for old in [k for k, w in self.items.items() if not (w.running or w.polling) and now - w.seen > LIVE_IDLE]:
                del self.items[old]
            win = self.items.get(sid)
            fresh = win is None or not win.order
            if win is None:
                win = self.items[sid] = LiveWindow(sid, source)
            win.headers = headers
            win.seen = now
            self._update(win, target, segments, body, final, now)
            if fresh:
                win.next_poll = now + max(0.5, min(target, segments[-1][2]) / 2)
                if win.ahead_on:
                    start = self.start_index(target, segments)
                    self._enqueue(win, win.order[start:start + self.ahead + 1])
            else:
                self._plan(win)
            self._start_poller(win)

    def cached_playlist(self, sid):
        """The poller's copy of the window while it keeps it current, else None."""
        if not self.ahead:
            return None
        now = time.monotonic()
        with self.lock:
            win = self.items.get(sid)
            if win is None or not win.polling or win.poll_errors or not win.body:
                return None
            if now - win.fetched > win.target + 0.5:
                return None
            win.seen = now
            return win.body

    def segment(self, sid, seq):
        """The player asked for segment `seq`: keep the next ones coming."""
        with self.lock:
            win = self.items.get(sid)
            if win is None:
                return
            win.seen = win.seg_seen = time.monotonic()
            win.asked.add(seq)
            if win.wanted is None or seq > win.wanted:
                win.wanted = seq
            self._plan(win, seq)

    def _plan(self, win, after=None):  # the caller holds self.lock
        if not win.ahead_on:
            return
        base = win.wanted if after is None else after
        if base is None or time.monotonic() - win.seg_seen > max(10.0, 3 * win.target):
            return  # only for a player that keeps asking for segments
        self._enqueue(win, [n for n in win.order if n > base][: self.ahead])

    def _enqueue(self, win, plan):  # the caller holds self.lock
        for seq in plan:
            if seq not in win.queued:
                win.queued.add(seq)
                win.queue.append(seq)
        if win.queue and not win.running:
            win.running = True
            try:
                threading.Thread(target=self._fetch, args=(win,), daemon=True).start()
            except RuntimeError:
                win.running = False

    def _start_poller(self, win):  # the caller holds self.lock
        if win.polling or not win.ahead_on:
            return
        win.polling = True
        win.poll_errors = 0
        try:
            threading.Thread(target=self._poll, args=(win,), daemon=True).start()
        except RuntimeError:
            win.polling = False

    def _fetch(self, win):
        """Download the queued segments of one window, one after the other."""
        while True:
            with self.lock:
                if self._idle(win, time.monotonic()) or not win.queue:
                    win.queue.clear()
                    win.running = False
                    return
                seq = win.queue.popleft()
                url = win.urls.get(seq)
                headers = win.headers
                if url:
                    win.fetched_ahead.add(seq)
            if not url:
                continue  # already out of the window
            seg, _started = self.cache.get(segment_key(url, seq), url, headers)
            if seg is None:
                continue  # no room right now: the player's own request fetches it
            deadline = time.monotonic() + 2 * STREAM_TIMEOUT
            with seg.cond:
                while not seg.done and not seg.failed:
                    left = deadline - time.monotonic()
                    if left <= 0:
                        break
                    seg.cond.wait(left)

    def _poll(self, win):
        """Re-read the playlist while its player plays, just after each new segment is due."""
        while True:
            with self.lock:
                now = time.monotonic()
                if self._idle(win, now) or not win.ahead_on or win.poll_errors >= 3:
                    win.polling = False
                    return
                wait = win.next_poll - now
                urls = [win.final, win.source] if win.final != win.source else [win.source]
                headers = win.headers
            if wait > 0:
                time.sleep(min(wait, 0.5))
                continue
            window = text = final = None
            for url in urls:
                try:
                    text, final = fetch_playlist(url, headers, timeout=CHECK_TIMEOUT)
                    window = parse_live_playlist(text, final)
                    break
                except Exception:
                    continue
            now = time.monotonic()
            with self.lock:
                if not window:
                    win.poll_errors += 1
                    win.next_poll = now + max(1.0, win.target / 2)
                    continue
                win.poll_errors = 0
                before = win.newest
                self._update(win, window[0], window[1], rewrite_hls(text, final, win.sid).encode("utf-8"), final, now)
                if win.newest > before:
                    win.next_poll = now + max(0.5, win.last_dur - 0.3)  # the next one is due about then
                elif now - win.changed > 2 * win.target:
                    win.next_poll = now + max(1.0, win.target / 2)  # the channel stalls: ask less often
                else:
                    win.next_poll = now + max(0.3, min(0.5, win.target / 4))
                self._plan(win)


_segments = SegmentCache(SEGMENT_CACHE_MB * 1024 * 1024) if SEGMENT_CACHE_MB > 0 else None
_live = LiveWindows(_segments, READ_AHEAD)
# ---------- /api/epg: programme guide (XMLTV) for the channel player ----------
# An IPTV account can name its guide: the url-tvg of its playlist, a link typed in
# Panel > IPTV, or the xmltv.php of an Xtream server. Guides are big (tens of MB
# of XML, usually gzipped), so the server downloads a guide once in the
# background, keeps only what airs from a little before now to a day ahead, and
# answers small JSON questions about a few channels at a time:
#
#   GET /api/epg?url=<guide>&c=<tvg-id>%0A<channel name>&c=…&hours=6&lang=ar
#
# A channel is found by its tvg-id (listchannels.epg_id), or else by its name.
# While a guide downloads the answer is 202 {"status": "loading", "retry": 3}.

EPG_MAX_MB = _env_int("CINEAURA_EPG_MAX_MB", 300)  # uncompressed XML read at most
EPG_TTL = 4 * 3600  # a guide is downloaded again after this many seconds
EPG_FAIL_TTL = 10 * 60  # a guide that failed is not tried again before this
EPG_KEEP = max(1, _env_int("CINEAURA_EPG_KEEP", 3))  # guides kept in memory
EPG_PAST = 2 * 3600  # programmes kept from this long ago…
EPG_AHEAD = 26 * 3600  # …until this far ahead
EPG_MAX_PROGRAMMES = 250000  # per guide (about 60-100 MB of memory)
EPG_DESC = 280  # characters of a description kept
EPG_WAIT = 2.0  # seconds a question waits for a guide that is still loading
EPG_TIMEOUT = 25  # seconds per connection / read
EPG_BUDGET = 180  # seconds for a whole download
EPG_NEW_PER_10MIN = 30  # new guide downloads started at most, every viewer together
EPG_MAX_CHANNELS = 60  # channels per question

_EPG_TIME_RE = re.compile(r"\s*(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})?\s*(?:([+-])(\d{2}):?(\d{2}))?")
_EPG_NOISE_RE = re.compile(
    r"\b(?:f?hd|uhd|sd|hq|lq|4k|8k|hevc|h\.?26[45]|\d{3,4}p|\d{2}fps|backup|vip|raw|multi(?:audio)?|direct|live)\b"
)
_EPG_PREFIX_RE = re.compile(r"^\s*(?:\|[^|]{1,14}\||[^\W\d_]{2,4}\s*[:|]|[^\W\d_]{2,3}\s+-\s+)\s*")


def epg_time(value):
    """XMLTV time ("20261016203000 +0100") -> seconds since the epoch, or None."""
    m = _EPG_TIME_RE.match(value or "")
    if not m:
        return None
    y, mo, d, h, mi, s = (int(x or 0) for x in m.groups()[:6])
    try:
        t = calendar.timegm((y, mo, d, h, mi, s, 0, 0, 0))
    except (OverflowError, ValueError):
        return None
    if m.group(7):
        offset = int(m.group(8)) * 3600 + int(m.group(9)) * 60
        t -= offset if m.group(7) == "+" else -offset
    return t


def epg_name_keys(name):
    """Ways to recognise a channel by its name: "AR: beIN Sports 1 HD" and
    "beIN SPORTS 1" both give "beinsports1"."""
    text = unicodedata.normalize("NFKD", str(name or "")).casefold()
    text = "".join(c for c in text if not unicodedata.combining(c)).replace("+", " plus ").replace("&", " and ")
    text = re.sub(r"[\[\(\{][^\]\)\}]{0,24}[\]\)\}]", " ", text)
    keys = []
    for variant in (text, _EPG_PREFIX_RE.sub(" ", text, count=1)):
        key = re.sub(r"[\W_]+", "", _EPG_NOISE_RE.sub(" ", variant))
        if key and key not in keys:
            keys.append(key)
    return keys


class EpgError(Exception):
    pass


def _epg_chunks(resp, deadline):
    """Body of the guide, unpacked (gzip / zlib / xz are recognised by their first bytes)."""
    first = resp.read(STREAM_CHUNK)
    if not first:
        return
    if first[:2] == b"\x1f\x8b" or first[:1] == b"\x78":
        unpack = zlib.decompressobj(47)  # gzip or zlib header, found by itself
    elif first[:6] == b"\xfd7zXZ\x00":
        unpack = lzma.LZMADecompressor()
    else:
        unpack = None
    chunk = first
    while chunk:
        if time.monotonic() > deadline:
            raise EpgError("timeout")
        if unpack is None:
            yield chunk
        elif isinstance(unpack, lzma.LZMADecompressor):
            if not unpack.eof:
                yield unpack.decompress(chunk)
        else:
            data = unpack.decompress(chunk, 1 << 20)
            while True:
                if data:
                    yield data
                if unpack.unconsumed_tail:
                    data = unpack.decompress(unpack.unconsumed_tail, 1 << 20)
                    continue
                if unpack.eof and unpack.unused_data:  # several gzip members, one after the other
                    rest = unpack.unused_data
                    unpack = zlib.decompressobj(47)
                    data = unpack.decompress(rest, 1 << 20)
                    continue
                break
        chunk = resp.read(STREAM_CHUNK)


class EpgGuide:
    def __init__(self, url):
        self.url = url
        self.state = "loading"  # loading | ready | error
        self.error = ""
        self.loaded_at = 0.0
        self.refreshing = True
        self.done = threading.Event()
        self.channels = {}  # channel id -> display name
        self.ids = {}  # casefolded id -> channel id
        self.names = {}  # name key -> channel id
        self.programmes = {}  # channel id -> [(start, stop, title, desc, {lang: title} | None)]
        self.count = 0

    def find(self, epg_id, name):
        epg_id = (epg_id or "").strip()
        if epg_id:
            if epg_id in self.programmes:
                return epg_id, "id"
            found = self.ids.get(epg_id.casefold())
            if found:
                return found, "id"
        for key in epg_name_keys(name):
            found = self.names.get(key)
            if found:
                return found, "name"
        if epg_id:  # tvg-ids are often names too: "beINSports1.qa"
            for key in epg_name_keys(re.sub(r"\.[a-z]{2,3}$", "", epg_id, flags=re.I)):
                found = self.names.get(key)
                if found:
                    return found, "name"
        return None, ""

    def lookup(self, wanted, hours, lang, now):
        out = []
        until = now + hours * 3600
        for epg_id, name in wanted:
            cid, how = self.find(epg_id, name)
            items = self.programmes.get(cid) if cid else None
            if not items:
                out.append(None)
                continue
            # the first programme that has not ended yet (the list is sorted by start)
            lo, hi = 0, len(items)
            while lo < hi:
                mid = (lo + hi) // 2
                if items[mid][1] <= now:
                    lo = mid + 1
                else:
                    hi = mid
            picked = []
            most = 2 if hours == 0 else 40  # hours=0: what is on now and what comes next
            for start, stop, title, desc, alt in items[lo:]:
                if len(picked) >= most or (picked and hours and start >= until):
                    break
                if alt and lang and lang in alt:
                    title = alt[lang]
                picked.append([start, stop, title, desc])
            out.append({"id": cid, "name": self.channels.get(cid, cid), "match": how, "programmes": picked})
        return out


def load_epg(url, now=None):
    """Download and read one guide. Returns the new EpgGuide data (raises EpgError)."""
    now = now or time.time()
    keep_from, keep_to = now - EPG_PAST, now + EPG_AHEAD
    deadline = time.monotonic() + EPG_BUDGET
    try:
        resp, _final = open_stream(url, {"User-Agent": "Mozilla/5.0 CineAura-EPG", "Accept": "*/*"}, timeout=EPG_TIMEOUT)
    except urllib.error.HTTPError as err:
        raise EpgError("http %d" % err.code)
    except (ValueError, PermissionError) as err:  # the SSRF guard: not a public address
        raise EpgError("blocked" if isinstance(err, PermissionError) else str(err) or "blocked")
    except (OSError, http.client.HTTPException) as err:
        raise EpgError(type(err).__name__)
    guide = EpgGuide(url)
    parser = ET.XMLPullParser(events=("start", "end"))
    limit = EPG_MAX_MB * 1024 * 1024
    total = 0
    seen_root = False
    root = None
    full = False
    try:
        with resp:
            for data in _epg_chunks(resp, deadline):
                if not data:
                    continue
                if not seen_root:
                    head = data[:8192].lstrip()
                    if b"<!ENTITY" in head.upper():
                        raise EpgError("entities")  # no entity tricks: a real guide has none
                    if not head.lstrip(b"\xef\xbb\xbf").lstrip().startswith((b"<?xml", b"<tv", b"<!DOCTYPE", b"<!--")):
                        raise EpgError("not xmltv")
                    seen_root = True
                total += len(data)
                if total > limit:
                    raise EpgError("too large")
                parser.feed(data)
                for event, el in parser.read_events():
                    if event == "start":
                        if root is None:
                            root = el
                        continue
                    tag = el.tag
                    if tag == "programme":
                        if not full:
                            _epg_programme(guide, el, keep_from, keep_to)
                            full = guide.count >= EPG_MAX_PROGRAMMES
                        el.clear()
                    elif tag == "channel":
                        cid = (el.get("id") or "").strip()
                        if cid:
                            names = [(dn.text or "").strip() for dn in el.findall("display-name")]
                            names = [n for n in names if n]
                            guide.channels[cid] = names[0] if names else cid
                            guide.ids.setdefault(cid.casefold(), cid)
                            for n in names + [cid]:
                                for key in epg_name_keys(n):
                                    guide.names.setdefault(key, cid)
                        el.clear()
                # what was read is no longer needed (an element still open stays with the parser)
                if root is not None:
                    root.clear()
            parser.close()
    except ET.ParseError as err:
        if not guide.count:
            raise EpgError("bad xml")
        sys.stderr.write("epg: %s: stopped at %s\n" % (url[:80], err))  # keep what was read
    if not seen_root:
        raise EpgError("empty")
    for items in guide.programmes.values():
        items.sort(key=lambda p: (p[0], p[1]))
    for cid in guide.programmes:
        guide.ids.setdefault(cid.casefold(), cid)
    return guide


def _epg_programme(guide, el, keep_from, keep_to):
    cid = (el.get("channel") or "").strip()
    start = epg_time(el.get("start"))
    if not cid or start is None:
        return
    stop = epg_time(el.get("stop")) or start + 1800
    if stop <= keep_from or start >= keep_to or stop <= start:
        return
    title, alt, desc = "", None, ""
    for child in el:
        if child.tag == "title" and child.text:
            text = sys.intern(child.text.strip()[:200])  # "News", "Movie": the same text is kept once
            if not title:
                title = text
            lang = (child.get("lang") or "").strip().lower()[:2]
            if lang:
                alt = alt or {}
                alt.setdefault(lang, text)
        elif child.tag == "desc" and child.text and not desc:
            desc = child.text.strip()[:EPG_DESC]
    if alt and len(alt) < 2:
        alt = None
    guide.programmes.setdefault(cid, []).append((start, stop, title, desc, alt))
    guide.count += 1


class EpgStore:
    def __init__(self):
        self.lock = threading.Lock()
        self.guides = collections.OrderedDict()  # url -> EpgGuide
        self.gate = threading.Semaphore(2)  # guides read at once (a slow one cannot hold up the others)
        self.started = collections.deque()  # when the last downloads began

    def get(self, url):
        """The guide for url, loading in the background if needed; None when too many new guides were asked for."""
        now = time.time()
        with self.lock:
            guide = self.guides.get(url)
            if guide is not None:
                self.guides.move_to_end(url)
                stale = now - guide.loaded_at > (EPG_FAIL_TTL if guide.state == "error" else EPG_TTL)
                if guide.state != "loading" and stale and not guide.refreshing:
                    guide.refreshing = True
                    if guide.state == "error":  # a new try: ask again in a moment
                        guide.state = "loading"
                        guide.done.clear()
                    self._spawn(guide)  # a ready guide is served until the new one is in
                return guide
            while self.started and now - self.started[0] > 600:
                self.started.popleft()
            if len(self.started) >= EPG_NEW_PER_10MIN:
                return None
            self.started.append(now)
            guide = EpgGuide(url)
            self.guides[url] = guide
            self._trim(now)
            self._spawn(guide)
            return guide

    def _trim(self, now):  # the caller holds self.lock
        # the least recently asked guides go first; a failed one is only remembered
        # (so that it is not downloaded again and again) for EPG_FAIL_TTL
        ready = [u for u, g in self.guides.items() if g.state == "ready"]
        for url in ready[: max(0, len(ready) - EPG_KEEP)]:
            del self.guides[url]
        for url, g in list(self.guides.items()):
            if g.state == "error" and (now - g.loaded_at > EPG_FAIL_TTL or len(self.guides) > 64):
                del self.guides[url]

    def _spawn(self, guide):
        threading.Thread(target=self._load, args=(guide,), name="epg", daemon=True).start()

    def _load(self, guide):
        with self.gate:
            try:
                fresh = load_epg(guide.url)
            except EpgError as err:
                fresh, error = None, str(err)
            except Exception as err:  # a broken guide must never take the server down
                fresh, error = None, type(err).__name__
        with self.lock:
            guide.loaded_at = time.time()
            guide.refreshing = False
            if fresh is not None:
                guide.channels, guide.ids, guide.names = fresh.channels, fresh.ids, fresh.names
                guide.programmes, guide.count = fresh.programmes, fresh.count
                guide.state, guide.error = "ready", ""
            elif guide.state == "ready":
                guide.loaded_at -= EPG_TTL - EPG_FAIL_TTL  # keep the old guide, try again sooner
            else:
                guide.state, guide.error = "error", error
            guide.done.set()
            self._trim(time.time())
        if fresh is None:
            sys.stderr.write("epg: %s: %s\n" % (guide.url[:80], error))


EPG = EpgStore()


_LIVE_ID_RE = re.compile(r"[0-9a-f]{16}")


class Handler(SimpleHTTPRequestHandler):
    # Keep-alive towards the browser (or the proxy in front of this server): the
    # playlist and segment requests of a live channel reuse one connection.
    # Every answer below states its length, or is sent in chunks.
    protocol_version = "HTTP/1.1"
    timeout = 45  # seconds a silent connection is kept

    extensions_map = {
        **SimpleHTTPRequestHandler.extensions_map,
        ".js": "application/javascript; charset=utf-8",
        ".css": "text/css; charset=utf-8",
        ".html": "text/html; charset=utf-8",
        ".json": "application/json; charset=utf-8",
        ".svg": "image/svg+xml",
        ".sql": "text/plain; charset=utf-8",
    }

    def proxy_m3u(self, parsed):
        url = (parse_qs(parsed.query).get("url") or [""])[0]
        try:
            body = fetch_m3u(url)
        except Exception:
            self.send_error(502, "Could not fetch playlist")
            return
        self.send_response(200)
        self.send_header("Content-Type", "text/plain; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def proxy_thumb(self, parsed):
        url = (parse_qs(parsed.query).get("url") or [""])[0]
        if not url.startswith(("http://", "https://")):
            self.send_error(400, "A full http(s) url is required")
            return
        payload = thumb_for(url)
        body = json.dumps(payload).encode("utf-8")
        self.send_response(200)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "public, max-age=3600")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()
        self.wfile.write(body)

    def proxy_providers(self, parsed):
        query = parse_qs(parsed.query)
        media = "tv" if (query.get("media") or ["movie"])[0] == "tv" else "movie"
        tmdb_id = (query.get("id") or [""])[0].strip()
        # only a bare ISO-3166-1 pair ever reaches the upstream URL
        region = re.sub(r"[^A-Z]", "", (query.get("region") or [""])[0].strip().upper())[:2]
        if not re.fullmatch(r"\d{1,10}", tmdb_id or ""):
            self.send_error(400, "A numeric TMDB id is required")
            return
        payload = providers_for(media, tmdb_id, region or "US")
        body = json.dumps(payload).encode("utf-8")
        self.send_response(200)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "public, max-age=1800")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()
        self.wfile.write(body)

    def begin_body(self, length):
        """Frame a body of `length` bytes (-1: unknown). True: it goes out in chunks."""
        if length >= 0:
            self.send_header("Content-Length", str(length))
            return False
        if self.request_version == "HTTP/1.1":
            self.send_header("Transfer-Encoding", "chunked")
            return True
        self.send_header("Connection", "close")
        return False

    def write_body(self, data, chunked):
        if chunked:
            self.wfile.write(b"%x\r\n%s\r\n" % (len(data), data))
        else:
            self.wfile.write(data)

    def send_cached(self, seg, label):
        """Answer with a kept segment, also while it is still arriving. False: nothing was sent."""
        deadline = time.monotonic() + STREAM_TIMEOUT
        with seg.cond:
            while not seg.ready and not seg.failed:
                left = deadline - time.monotonic()
                if left <= 0:
                    break
                seg.cond.wait(left)
            if not seg.ready:
                return False
            status, ctype, length = seg.status, seg.ctype, seg.length
            if seg.done:
                label = "hit"
        self.send_response(status)
        self.send_header("Content-Type", ctype)
        chunked = self.begin_body(length)
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("X-Relay-Cache", label)
        self.end_headers()
        sent = 0
        complete = False
        try:
            while True:
                with seg.cond:
                    while sent >= len(seg.chunks) and not seg.done and not seg.failed:
                        if not seg.cond.wait(STREAM_TIMEOUT):
                            break
                    chunks = seg.chunks[sent:]
                    finished = seg.done
                for chunk in chunks:
                    self.write_body(chunk, chunked)
                sent += len(chunks)
                if finished and sent >= len(seg.chunks):
                    complete = True
                    break
                if not chunks:
                    break  # the download failed, or sent nothing for STREAM_TIMEOUT
            if complete and chunked:
                self.wfile.write(b"0\r\n\r\n")
        except OSError:  # the viewer went away
            complete = False
        if not complete:
            self.close_connection = True  # a cut answer must not look complete
        return True

    def proxy_stream(self, parsed):
        query = parse_qs(parsed.query)
        if (query.get("probe") or [""])[0]:
            # the player asks once whether this server offers the relay at all
            self.send_response(204)
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            return
        url = (query.get("url") or [""])[0].strip()
        if not url.startswith(("http://", "https://")):
            self.send_error(400, "A full http(s) url is required")
            return
        headers = {
            "User-Agent": self.headers.get("User-Agent") or "Mozilla/5.0 CineAura-Player",
            "Accept": "*/*",
        }
        wanted_range = (self.headers.get("Range") or "").strip()
        if re.fullmatch(r"bytes=\d*-\d*", wanted_range):
            headers["Range"] = wanted_range  # seeking inside films and series episodes
        else:
            wanted_range = ""
        # a segment of a live window (rewrite_hls tagged it): kept, shared, fetched ahead
        seq = (query.get("seq") or [""])[0]
        live = (query.get("live") or [""])[0]
        if _segments is not None and not wanted_range and seq.isdigit() and len(seq) <= 18 and _LIVE_ID_RE.fullmatch(live):
            _live.segment(live, int(seq))
            seg, started = _segments.get(segment_key(url, int(seq)), url, headers)
            if seg is not None and self.send_cached(seg, "miss" if started else "join"):
                return
        elif not wanted_range:
            cached = _live.cached_playlist(live_id(url))
            if cached is not None:
                self.send_response(200)
                self.send_header("Content-Type", "application/vnd.apple.mpegurl")
                self.send_header("Content-Length", str(len(cached)))
                self.send_header("Cache-Control", "no-store")
                self.send_header("X-Content-Type-Options", "nosniff")
                self.send_header("X-Relay-Cache", "hit")
                self.end_headers()
                self.wfile.write(cached)
                return
        try:
            resp, final_url = open_stream(url, headers)
        except PermissionError:
            self.send_error(403, "Address not allowed")
            return
        except urllib.error.HTTPError as err:
            code = err.code if 400 <= err.code < 600 else 502
            err.close()
            self.send_error(code, "Upstream error")
            return
        except (socket.timeout, TimeoutError):
            self.send_error(504, "Upstream timeout")
            return
        except Exception:
            self.send_error(502, "Could not reach the stream")
            return
        with resp:
            content_type = (resp.headers.get("Content-Type") or "").split(";")[0].strip().lower()
            try:
                head = resp.read1(STREAM_CHUNK)
            except Exception:
                self.send_error(502, "Could not read the stream")
                return
            if is_hls_playlist(content_type, head):
                try:
                    raw = head + resp.read(MAX_HLS_PLAYLIST + 1 - len(head))
                except Exception:
                    self.send_error(502, "Could not read the playlist")
                    return
                if len(raw) > MAX_HLS_PLAYLIST:
                    self.send_error(502, "Playlist too large")
                    return
                text = raw.decode("utf-8", "replace").lstrip("\ufeff")
                window = parse_live_playlist(text, final_url) if _segments is not None else None
                if window:
                    sid = live_id(url)
                    body = rewrite_hls(text, final_url, sid).encode("utf-8")
                    _live.playlist(sid, url, final_url, window[0], window[1], body, dict(headers))
                else:
                    body = rewrite_hls(text, final_url).encode("utf-8")
                self.send_response(200)
                self.send_header("Content-Type", "application/vnd.apple.mpegurl")
                self.send_header("Content-Length", str(len(body)))
                self.send_header("Cache-Control", "no-store")
                self.send_header("X-Content-Type-Options", "nosniff")
                self.end_headers()
                self.wfile.write(body)
                return
            labelled = is_relayable_media(content_type)
            try:
                length = int(resp.headers.get("Content-Length") or -1)
            except ValueError:
                length = -1
            # an HLS AES-128 key is exactly 16 bytes, whatever its label
            if not (labelled or looks_like_media(head) or length == 16):
                self.send_error(415, "Only audio and video can be relayed")
                return
            self.send_response(resp.status if resp.status in (200, 206) else 200)
            self.send_header("Content-Type", (content_type if labelled else "") or "application/octet-stream")
            for name in ("Content-Range", "Accept-Ranges"):
                value = resp.headers.get(name)
                if value:
                    self.send_header(name, value)
            chunked = self.begin_body(length)
            self.send_header("Cache-Control", "no-store")
            self.send_header("X-Content-Type-Options", "nosniff")
            self.end_headers()
            # a live channel never ends: copy until the viewer closes the player
            sent = 0
            complete = False
            try:
                chunk = head
                while chunk:
                    self.write_body(chunk, chunked)
                    sent += len(chunk)
                    chunk = resp.read1(STREAM_CHUNK)
                complete = length < 0 or sent == length
                if complete and chunked:
                    self.wfile.write(b"0\r\n\r\n")
            except (OSError, http.client.HTTPException):  # viewer gone, or upstream stalled or cut
                complete = False
            if not complete:
                self.close_connection = True

    def send_json(self, status, payload, cache="no-store"):
        body = json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", cache)
        self.end_headers()
        self.wfile.write(body)

    def epg_lookup(self, parsed):
        query = parse_qs(parsed.query)
        url = (query.get("url") or [""])[0].strip()
        if not url.startswith(("http://", "https://")) or len(url) > 4000:
            return self.send_json(400, {"status": "error", "error": "bad url"})
        wanted = []
        for raw in (query.get("c") or [])[:EPG_MAX_CHANNELS]:
            epg_id, _sep, name = raw.partition("\n")
            wanted.append((epg_id.strip()[:200], name.strip()[:200]))
        try:
            hours = max(0, min(26, int((query.get("hours") or ["6"])[0])))
        except ValueError:
            hours = 6
        lang = re.sub(r"[^a-z]", "", (query.get("lang") or [""])[0].lower())[:2]
        guide = EPG.get(url)
        if guide is None:
            return self.send_json(429, {"status": "busy", "retry": 60})
        if guide.state == "loading":
            guide.done.wait(EPG_WAIT)
        if guide.state == "loading":
            return self.send_json(202, {"status": "loading", "retry": 3})
        if guide.state == "error":
            return self.send_json(502, {"status": "error", "error": guide.error})
        now = int(time.time())
        payload = {"status": "ok", "now": now, "updated": int(guide.loaded_at), "channels": guide.lookup(wanted, hours, lang, now)}
        self.send_json(200, payload, cache="private, max-age=60")

    def stream_check(self, parsed):
        query = parse_qs(parsed.query)
        if (query.get("probe") or [""])[0]:
            # the channel list asks once whether this server can check channels
            self.send_response(204)
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            return
        links = []
        for name in ("url", "alt"):
            value = (query.get(name) or [""])[0].strip()
            if value.startswith(("http://", "https://")) and len(value) <= 4000 and value not in links:
                links.append(value)
        if not links:
            self.send_error(400, "A full http(s) url is required")
            return
        body = json.dumps(check_stream(links, self.headers.get("User-Agent"))).encode("utf-8")
        self.send_response(200)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        parsed = urlparse(self.path)
        if parsed.path == "/api/m3u":
            return self.proxy_m3u(parsed)
        if parsed.path == "/api/thumb":
            return self.proxy_thumb(parsed)
        if parsed.path == "/api/providers":
            return self.proxy_providers(parsed)
        if parsed.path == "/api/stream":
            return self.proxy_stream(parsed)
        if parsed.path == "/api/stream-check":
            return self.stream_check(parsed)
        if parsed.path == "/api/epg":
            return self.epg_lookup(parsed)
        mapped = ROUTES.get(parsed.path)
        if mapped and not os.path.exists(os.path.join(ROOT, mapped)):
            # the page may sit in the checkout with another case (listchannels.html)
            mapped = resolve_clean_url("/" + mapped)
        mapped = mapped or resolve_clean_url(parsed.path)
        if mapped:
            self.path = "/" + mapped
        return super().do_GET()

    def log_message(self, fmt, *args):
        sys.stderr.write("%s - %s\n" % (self.address_string(), fmt % args))


if __name__ == "__main__":
    port = int(os.environ.get("PORT", "8080"))
    httpd = ThreadingHTTPServer(("0.0.0.0", port), Handler)
    print(f"CineAura serving on http://0.0.0.0:{port}", flush=True)
    httpd.serve_forever()

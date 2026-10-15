#!/usr/bin/env python3
from http.server import ThreadingHTTPServer, SimpleHTTPRequestHandler
from urllib.parse import urlparse, parse_qs, urljoin, unquote, quote
import base64
import io
import html as html_module
import ipaddress
import json
import os
import re
import time
import socket
import sys
import urllib.error
import urllib.request

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


def is_public_http_url(url):
    """Allow only http(s) URLs that resolve to public addresses (SSRF guard)."""
    p = urlparse(url)
    if p.scheme not in ("http", "https") or not p.hostname:
        return False
    try:
        infos = socket.getaddrinfo(p.hostname, p.port or (443 if p.scheme == "https" else 80))
    except OSError:
        return False
    for info in infos:
        ip = ipaddress.ip_address(info[4][0])
        if ip.is_private or ip.is_loopback or ip.is_link_local or ip.is_reserved or ip.is_multicast or ip.is_unspecified:
            return False
    return True


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


def rewrite_hls(text, base):
    """Point every URI of an HLS playlist (variants, segments, keys, maps) at the relay."""
    out = []
    for line in text.splitlines():
        s = line.strip()
        if not s:
            continue
        if s.startswith("#"):
            if 'URI="' in s:
                s = _HLS_URI_RE.sub(lambda m: 'URI="%s"' % stream_relay_url(urljoin(base, m.group(1))), s)
            out.append(s)
        else:
            out.append(stream_relay_url(urljoin(base, s)))
    return "\n".join(out) + "\n"


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


def open_stream(url, headers):
    """Open an upstream stream, following redirects through the SSRF guard.

    Returns (response, final_url): relative URIs in a playlist are resolved
    against the address the playlist really came from (IPTV servers often
    redirect to a load balancer with a token).
    """
    opener = urllib.request.build_opener(_NoRedirect)
    for _ in range(6):
        if not is_public_http_url(url):
            raise PermissionError("blocked")
        req = urllib.request.Request(url, headers=headers)
        try:
            return opener.open(req, timeout=STREAM_TIMEOUT), url
        except urllib.error.HTTPError as err:
            if err.code in (301, 302, 303, 307, 308) and err.headers.get("Location"):
                url = urljoin(url, err.headers["Location"])
                err.close()
                continue
            raise
    raise ValueError("too many redirects")


class Handler(SimpleHTTPRequestHandler):
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
                body = rewrite_hls(raw.decode("utf-8", "replace").lstrip("\ufeff"), final_url).encode("utf-8")
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
            for name in ("Content-Length", "Content-Range", "Accept-Ranges"):
                value = resp.headers.get(name)
                if value:
                    self.send_header(name, value)
            self.send_header("Cache-Control", "no-store")
            self.send_header("X-Content-Type-Options", "nosniff")
            self.end_headers()
            # a live channel never ends: copy until the viewer closes the player
            try:
                chunk = head
                while chunk:
                    self.wfile.write(chunk)
                    chunk = resp.read1(STREAM_CHUNK)
            except OSError:  # viewer gone (broken pipe / reset) or upstream stalled
                self.close_connection = True

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

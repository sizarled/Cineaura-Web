/* Home page > Members' videos.

   A row of the 12 videos with the most watched minutes (content_search, sql/content.sql),
   scrolling sideways like Featured Movies, and the Explore button: Content.html, the
   search box and the 50 most watched / liked / shared videos (the three links beside
   it open one list each). Visitors see the public and exclusive videos, members also
   the private ones they were given (the same rules as Search.html).
   Without sql/content.sql, or before any video is published, the row stays hidden and
   Explore is still there.
*/
(() => {
  "use strict";
  const C = window.CineAura;
  const V = window.CineAuraVideos;
  if (!C || !V) return;
  const { t, escapeHtml: esc } = C;

  const MAX = 12;
  const CLOCK = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/></svg>';
  let items = null;

  function draw() {
    const row = document.getElementById("videos-row");
    const track = document.getElementById("videos-track");
    if (!row || !track || !items) return;
    track.removeAttribute("aria-busy");
    if (!items.length) {
      row.hidden = true;
      return;
    }
    track.innerHTML = items
      .map((x) => V.cardHtml(x, { stat: `${CLOCK}<span>${esc(t("vid.hub.statMinutes", { n: V.fmtCount(x.minutes) }))}</span>` }))
      .join("");
    row.hidden = false;
    V.observeCards(track);
  }

  async function load() {
    const res = await V.call("content_search", { p_member: V.memberId(), p_sort: "minutes", p_limit: MAX });
    items = res.ok && Array.isArray(res.data?.items) ? res.data.items : [];
    draw();
  }

  // the cards carry translated words (views, "2 days ago"): drawn again in a new language
  document.addEventListener("cineaura:prefs", draw);
  document.addEventListener("DOMContentLoaded", load);
})();

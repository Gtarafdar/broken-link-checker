(function () {
  var root = document.getElementById("lightbox");
  if (!root) return;

  var img = root.querySelector(".lightbox__img");
  var caption = root.querySelector(".lightbox__caption");
  var lastFocus = null;

  function openLightbox(src, alt, captionText) {
    lastFocus = document.activeElement;
    img.src = src;
    img.alt = alt || "";
    caption.textContent = captionText || "";
    root.hidden = false;
    document.body.classList.add("lightbox-open");
    var closeBtn = root.querySelector(".lightbox__close");
    if (closeBtn) closeBtn.focus();
  }

  function closeLightbox() {
    root.hidden = true;
    document.body.classList.remove("lightbox-open");
    img.removeAttribute("src");
    img.alt = "";
    caption.textContent = "";
    if (lastFocus && typeof lastFocus.focus === "function") lastFocus.focus();
  }

  document.querySelectorAll(".shot-open").forEach(function (el) {
    el.addEventListener("click", function () {
      openLightbox(
        el.getAttribute("data-lightbox-src"),
        el.getAttribute("data-lightbox-alt"),
        el.getAttribute("data-lightbox-caption")
      );
    });
  });

  root.querySelectorAll("[data-lightbox-close]").forEach(function (el) {
    el.addEventListener("click", closeLightbox);
  });

  document.addEventListener("keydown", function (e) {
    if (root.hidden) return;
    if (e.key === "Escape") closeLightbox();
  });
})();

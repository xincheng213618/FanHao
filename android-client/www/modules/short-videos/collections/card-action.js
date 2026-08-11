export function appendCollectionCardAction(wrap, video, showPicker) {
  const add = document.createElement("button");
  add.type = "button";
  add.className = "short-video-mobile-collection-add";
  add.setAttribute("aria-label", "加入清单");
  add.textContent = "+";
  add.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    showPicker(video);
  });
  wrap.append(add);
}

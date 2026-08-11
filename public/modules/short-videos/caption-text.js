export function createShortVideoCaptionText({ normalizeTopic, openTopic }) {
  return function appendCaptionText(target, text, video = null) {
    const value = String(text || "");
    const knownTags = (Array.isArray(video?.tags) ? video.tags : [])
      .map((tag) => normalizeTopic(tag))
      .filter(Boolean)
      .sort((a, b) => b.length - a.length);
    const pattern = /#([^\s#]+)/g;
    let cursor = 0;
    let match;
    while ((match = pattern.exec(value))) {
      if (match.index > cursor) target.append(document.createTextNode(value.slice(cursor, match.index)));
      const token = String(match[1] || "");
      const recognized = knownTags.find((tag) => token === tag || token.startsWith(tag));
      const topic = normalizeTopic(recognized || token.split(/[@＠,，。.!！?？:：;；、()（）\[\]【】{}]/)[0]);
      if (topic) {
        const tag = document.createElement("button");
        tag.type = "button";
        tag.className = "short-video-caption-tag";
        tag.textContent = `#${topic}`;
        tag.title = `查看话题 ${topic}`;
        tag.addEventListener("click", (event) => {
          event.preventDefault();
          event.stopPropagation();
          if (video) openTopic(video, topic);
        });
        target.append(tag);
        const remainder = token.slice(topic.length);
        if (remainder) target.append(document.createTextNode(remainder));
      } else {
        target.append(document.createTextNode(match[0]));
      }
      cursor = pattern.lastIndex;
    }
    if (cursor < value.length) target.append(document.createTextNode(value.slice(cursor)));
  };
}

export function captionTitleWithTags(video) {
  const text = String(video?.title || "").trim();
  if (text.includes("#")) return text;
  const tags = Array.isArray(video?.tags) ? video.tags.filter(Boolean).slice(0, 4) : [];
  if (!tags.length) return text;
  return [text, tags.map((tag) => `#${String(tag).replace(/^#/, "")}`).join(" ")].filter(Boolean).join(" ");
}

export function createShortVideoTranscodeStatusButton({ createIcon }) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "short-video-distribution-toggle short-video-transcode-status-toggle";
  button.title = "打开独立的 FFmpeg 转码管理页面";
  button.append(createIcon("repeat"), document.createTextNode("转码管理"));
  button.addEventListener("click", () => {
    window.open("/short-videos/transcoding", "_blank", "noopener,noreferrer");
  });
  return button;
}

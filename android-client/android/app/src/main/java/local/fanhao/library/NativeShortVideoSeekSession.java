package local.fanhao.library;

/** One progress drag owns its logical source, audio epoch and pointer. */
final class NativeShortVideoSeekSession {
  private Object view;
  private Object player;
  private Object source;
  private String itemId;
  private int pointerId = -1;
  private Object owner;
  private long audioGeneration;
  private float latestX;

  void begin(Object view, Object player, Object source, String itemId, int pointerId,
      long audioGeneration, float x) {
    this.view = view;
    this.player = player;
    this.source = source;
    this.itemId = itemId;
    this.pointerId = pointerId;
    this.audioGeneration = audioGeneration;
    latestX = x;
    owner = new Object();
  }

  boolean owns(Object view, Object player, Object source, String itemId, long audioGeneration) {
    return this.view != null && this.view == view && this.player == player
      && this.source != null && this.source == source && this.itemId != null && this.itemId.equals(itemId)
      && this.audioGeneration == audioGeneration;
  }

  Object view() { return view; }
  int pointerId() { return pointerId; }
  Object owner() { return owner; }
  void move(float x) { latestX = x; }
  float x() { return latestX; }

  void cancel() {
    view = player = source = null;
    itemId = null;
    pointerId = -1;
    owner = null;
    audioGeneration = 0L;
  }
}

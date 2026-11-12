package local.fanhao.library;

import android.content.Context;
import android.net.Uri;
import android.util.Log;

import androidx.media3.common.C;
import androidx.media3.common.MediaItem;
import androidx.media3.common.MimeTypes;
import androidx.media3.common.util.UnstableApi;
import androidx.media3.datasource.ByteArrayDataSource;
import androidx.media3.datasource.DataSource;
import androidx.media3.datasource.DataSpec;
import androidx.media3.datasource.DefaultDataSource;
import androidx.media3.datasource.DefaultHttpDataSource;
import androidx.media3.datasource.TransferListener;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Collections;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;

@UnstableApi
final class NativePlayerSubtitles {
  private static final String TAG = "FanHaoSubtitles";
  private static final byte[] EMPTY_VTT = "WEBVTT\n\n".getBytes(StandardCharsets.UTF_8);
  private static final int MAX_VTT_BYTES = 8 * 1024 * 1024;
  private final List<MediaItem.SubtitleConfiguration> tracks;
  private final Set<String> trackPaths;

  private NativePlayerSubtitles(List<MediaItem.SubtitleConfiguration> tracks, Set<String> trackPaths) {
    this.tracks = tracks;
    this.trackPaths = trackPaths;
  }

  static NativePlayerSubtitles read(String source, String workId, String videoId, String json) {
    List<MediaItem.SubtitleConfiguration> tracks = new ArrayList<>();
    Set<String> paths = new HashSet<>();
    String origin = ServerAuthSession.origin(source);
    if (origin.isEmpty() || workId.isEmpty() || videoId.isEmpty() || json.isEmpty()) {
      return new NativePlayerSubtitles(tracks, paths);
    }
    boolean selectedDefault = false;
    try {
      JSONArray items = new JSONArray(json);
      for (int index = 0; index < items.length() && index < 64; index++) {
        JSONObject item = items.optJSONObject(index);
        if (item == null) continue;
        Uri url = Uri.parse(item.optString("url"));
        String id = item.optString("id");
        List<String> parts = url.getPathSegments();
        if (id.isEmpty() || id.length() > 256 || url.toString().length() > 1024
            || !origin.equals(ServerAuthSession.origin(url.toString()))
            || parts.size() != 6 || !"api".equals(parts.get(0)) || !"works".equals(parts.get(1))
            || !workId.equals(parts.get(2)) || !"subtitles".equals(parts.get(3))
            || !"tracks".equals(parts.get(4)) || !id.equals(parts.get(5))
            || !videoId.equals(url.getQueryParameter("videoId")) || !paths.add(url.getEncodedPath())) continue;
        boolean autoSelect = !selectedDefault && item.optBoolean("autoSelect");
        selectedDefault |= autoSelect;
        // Media3's menu prefers a language name over the label. The server
        // label already includes the language and distinguishes same-language files.
        tracks.add(new MediaItem.SubtitleConfiguration.Builder(
          url.buildUpon().clearQuery().fragment(null).appendQueryParameter("videoId", videoId).build()
        )
          .setMimeType(MimeTypes.TEXT_VTT)
          .setId(id)
          .setLabel(item.optString("label", "字幕"))
          .setSelectionFlags(autoSelect ? C.SELECTION_FLAG_DEFAULT : 0)
          .build());
      }
    } catch (JSONException error) {
      Log.w(TAG, "Unable to read subtitle configuration", error);
    }
    return new NativePlayerSubtitles(tracks, paths);
  }

  boolean isEmpty() {
    return tracks.isEmpty();
  }

  String[] preferredLabels() {
    for (MediaItem.SubtitleConfiguration track : tracks) {
      if ((track.selectionFlags & C.SELECTION_FLAG_DEFAULT) != 0) return new String[] { track.label };
    }
    return new String[0];
  }

  List<MediaItem.SubtitleConfiguration> configurations(long streamOffsetMs) {
    if (streamOffsetMs <= 0) return tracks;
    List<MediaItem.SubtitleConfiguration> shifted = new ArrayList<>(tracks.size());
    for (MediaItem.SubtitleConfiguration track : tracks) {
      Uri url = track.uri.buildUpon()
        .appendQueryParameter("offsetSeconds", Double.toString(-streamOffsetMs / 1000.0))
        .build();
      shifted.add(track.buildUpon().setUri(url).build());
    }
    return shifted;
  }

  DataSource.Factory createDataSourceFactory(Context context, String source, String token, String accountOwner) {
    DefaultDataSource.Factory videoSource = new DefaultDataSource.Factory(context);
    DefaultHttpDataSource.Factory subtitleSource = new DefaultHttpDataSource.Factory()
      .setConnectTimeoutMs(3000).setReadTimeoutMs(3000);
    return () -> new DataSource() {
      private final List<TransferListener> listeners = new ArrayList<>();
      private DataSource active;

      @Override public void addTransferListener(TransferListener listener) {
        listeners.add(listener);
        if (active != null) active.addTransferListener(listener);
      }

      private long open(DataSource dataSource, DataSpec request) throws IOException {
        active = dataSource;
        for (TransferListener listener : listeners) active.addTransferListener(listener);
        return active.open(request);
      }

      @Override public long open(DataSpec request) throws IOException {
        if (!trackPaths.contains(request.uri.getEncodedPath())
            || !ServerAuthSession.origin(source).equals(ServerAuthSession.origin(request.uri.toString()))) {
          return open(videoSource.createDataSource(), request);
        }
        byte[] bytes = readVtt(subtitleSource, source, token, accountOwner, request.uri);
        return bytes == EMPTY_VTT || request.position >= bytes.length
          ? open(new ByteArrayDataSource(EMPTY_VTT), new DataSpec(request.uri))
          : open(new ByteArrayDataSource(bytes), request);
      }

      @Override public int read(byte[] target, int offset, int length) throws IOException {
        return active.read(target, offset, length);
      }

      @Override public Uri getUri() {
        return active == null ? null : active.getUri();
      }

      @Override public Map<String, List<String>> getResponseHeaders() {
        return active == null ? Collections.emptyMap() : active.getResponseHeaders();
      }

      @Override public void close() throws IOException {
        DataSource dataSource = active;
        active = null;
        if (dataSource != null) dataSource.close();
      }
    };
  }

  private static byte[] readVtt(DataSource.Factory factory, String source, String token, String accountOwner, Uri url) {
    DataSource network = factory.createDataSource();
    try (ServerAuthSession.RequestScope ignored = ServerAuthSession.bindRequest(source, url.toString(), token)) {
      DataSpec request = new DataSpec(url);
      if ("guest".equals(accountOwner) || accountOwner.matches("account:[A-Za-z0-9_-]{1,256}")) {
        request = request.withRequestHeaders(Collections.singletonMap("X-FanHao-Account-Owner", accountOwner));
      }
      long declaredSize = network.open(request);
      if (declaredSize > MAX_VTT_BYTES) throw new IOException("Subtitle exceeds size limit");
      ByteArrayOutputStream output = new ByteArrayOutputStream();
      byte[] chunk = new byte[8192];
      int count;
      while ((count = network.read(chunk, 0, chunk.length)) != C.RESULT_END_OF_INPUT) {
        if (output.size() + count > MAX_VTT_BYTES) throw new IOException("Subtitle exceeds size limit");
        output.write(chunk, 0, count);
      }
      byte[] bytes = output.toByteArray();
      if ((declaredSize >= 0 && declaredSize != bytes.length) || bytes.length < EMPTY_VTT.length
          || !new String(bytes, 0, EMPTY_VTT.length, StandardCharsets.UTF_8).equals("WEBVTT\n\n")) {
        throw new IOException("Subtitle did not contain complete WebVTT");
      }
      return bytes;
    } catch (IOException error) {
      // Media3 merges external tracks into playback. Keep a failed subtitle from failing the video.
      Log.w(TAG, "Subtitle track unavailable");
      return EMPTY_VTT;
    } finally {
      try { network.close(); } catch (IOException ignored) {}
    }
  }
}

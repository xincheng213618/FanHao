package local.fanhao.library;

import androidx.media3.datasource.DataSource;
import java.util.function.BooleanSupplier;
import java.util.function.Supplier;

/** Chooses a ready factory for each new source, never replacing an open source. */
final class NativeShortVideoCacheDataSourceFactory implements DataSource.Factory {
  private final DataSource.Factory network;
  private final Supplier<DataSource.Factory> ready;
  private final Runnable requestInitialization;
  private final BooleanSupplier isOpen;

  NativeShortVideoCacheDataSourceFactory(DataSource.Factory network, Supplier<DataSource.Factory> ready,
    Runnable requestInitialization, BooleanSupplier isOpen) {
    this.network = network;
    this.ready = ready;
    this.requestInitialization = requestInitialization;
    this.isOpen = isOpen;
  }

  @Override public DataSource createDataSource() {
    if (!isOpen.getAsBoolean()) throw new IllegalStateException("Video cache owner is closed");
    DataSource.Factory factory = ready.get();
    if (factory == null) {
      requestInitialization.run();
      factory = ready.get();
    }
    if (!isOpen.getAsBoolean()) throw new IllegalStateException("Video cache owner is closed");
    return (factory == null ? network : factory).createDataSource();
  }
}

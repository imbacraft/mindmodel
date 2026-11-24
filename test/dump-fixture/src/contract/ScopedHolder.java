package contract;

/** A holder of the project's own: a subclass of a JDK holder, so the type alone is not the JDK's name. */
public class ScopedHolder extends InheritableThreadLocal<String> {
    static final ScopedHolder INSTANCE = new ScopedHolder();

    void store(String value) {
        INSTANCE.set(value);
    }

    void clear() {
        INSTANCE.remove();
    }
}

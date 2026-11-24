package contract;

/** A project context holder: a static ThreadLocal with a setter and a clearer, the shape a filter writes through. */
public final class RequestHolder {
    private static final ThreadLocal<String> CURRENT = new ThreadLocal<>();

    private RequestHolder() { }

    public static void set(String value) {
        CURRENT.set(value);
    }

    public static String get() {
        return CURRENT.get();
    }

    public static void remove() {
        CURRENT.remove();
    }
}

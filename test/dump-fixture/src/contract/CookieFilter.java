package contract;

/** A cookie-name parameter compared with a constant, inside a helper the filter calls with a literal. */
public class CookieFilter {
    static final String SESSION = "session";

    boolean read(String cookieName) {
        return SESSION.equals(cookieName);
    }

    boolean handle() {
        return read("session");
    }
}

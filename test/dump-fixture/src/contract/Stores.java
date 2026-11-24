package contract;

/** Every place a value is stored for the current request: a project holder, its own ThreadLocal, an attribute, a context. */
public class Stores {
    static final ThreadLocal<String> SLOT = new ThreadLocal<>();

    void holder(String value) {
        RequestHolder.set(value);
        SLOT.set(value);
        SLOT.remove();
    }

    void attribute(jakarta.servlet.http.HttpServletRequest request, String value) {
        request.setAttribute("user", value);
    }

    void session(jakarta.servlet.http.HttpServletRequest request, String value) {
        request.getSession().setAttribute("user", value);
    }

    void context(org.springframework.security.core.context.SecurityContext context, Object user) {
        context.setAuthentication(user);
    }
}

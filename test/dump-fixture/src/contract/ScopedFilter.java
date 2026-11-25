package contract;

/**
 * A request-scoped store found by shape, never by a name: a call on one type inside the try — here one hop away, in a
 * project method — and a call on the same type in that try's finally. The type is not declared in the project, so the
 * store has to be read off the shape the dump records.
 */
public class ScopedFilter {
    void doFilterInternal(boolean cookie) {
        try {
            if (cookie) remember("user");
        } finally {
            library.ContextHolder.clear();
        }
    }

    private void remember(String user) {
        library.ContextHolder.set(user);
    }
}

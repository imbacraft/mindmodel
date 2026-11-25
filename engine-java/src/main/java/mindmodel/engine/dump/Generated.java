package mindmodel.engine.dump;

/**
 * Whether a project-relative path is build output: a type read from one of those directories is resolved for its
 * shape and never treated as code the project wrote.
 */
public final class Generated {

    private static final String[] MARKS = { "/target/generated-sources/", "/target/generated-test-sources/",
            "/build/generated/", "/build/generated-sources/" };

    private Generated() {
    }

    public static boolean is(String rel) {
        if (rel == null) return false;
        String path = "/" + rel;
        for (String mark : MARKS) if (path.contains(mark)) return true;
        return false;
    }
}

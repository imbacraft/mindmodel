package mindmodel.engine.dump;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotEquals;

import java.nio.file.Path;
import java.util.Map;

import com.fasterxml.jackson.databind.JsonNode;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

/** Folded values: Java's integer semantics, and which fields may be read as constants at all. */
class ValuesTest {

    @TempDir
    Path dir;

    private static final String BOUNDS = "package demo; public @interface Bounds { int h(); int big(); long wide(); }";

    private static final String CONSTS = """
            package demo;
            @Bounds(h = Consts.H, big = Consts.BIG, wide = Consts.WIDE)
            public class Consts {
                static final int H = 7 / 2;
                static final int BIG = 100000 * 100000;
                static final long WIDE = 100000L * 100000L;
            }
            """;

    /** The call whose first argument is written as {@code text}. */
    private static JsonNode withArgText(java.util.List<JsonNode> rows, String text) {
        return rows.stream().filter(r -> text.equals(r.path("args").path(0).path("text").asText()))
                .findFirst().orElseThrow(() -> new AssertionError("no call with argument " + text));
    }

    @Test
    void integerDivisionAndOverflowFoldWithJavaIntSemantics() throws Exception {
        JsonNode type = DumpRun.one(DumpRun.of(dir, Map.of(
                "demo/Bounds.java", BOUNDS, "demo/Consts.java", CONSTS)).rows("types"), "fqn", "demo.Consts");

        JsonNode args = type.path("ann").get(0).path("args");
        assertEquals("int", args.path("h").path("kind").asText());
        assertEquals(3, args.path("h").path("value").asInt(), "7 / 2 is 3 in int");
        assertEquals(1410065408, args.path("big").path("value").asInt(), "100000 * 100000 wraps in int");
        assertEquals(10000000000L, args.path("wide").path("value").asLong(), "long arithmetic does not wrap here");
    }

    @Test
    void staticNonFinalFieldIsNotAConstant() throws Exception {
        String holder = """
                package demo;
                public class Holder {
                    static String MODE = "a";
                    static final String FIXED = "b";
                    public static void run() { use(MODE); use(FIXED); }
                    static void use(String s) { }
                }
                """;
        var rows = DumpRun.of(dir, Map.of("demo/Holder.java", holder)).rows("calls");

        JsonNode mode = withArgText(rows, "MODE");
        assertEquals("field", mode.path("args").get(0).path("kind").asText(), "MODE is not final");
        JsonNode fixed = withArgText(rows, "FIXED");
        assertEquals("constant", fixed.path("args").get(0).path("kind").asText());
    }

    @Test
    void nonStaticOrNonFinalEnumTypedFieldIsNotAnEnumConstant() throws Exception {
        String holder = """
                package demo;
                public class Holder {
                    enum Mode { A, B }
                    static Mode CURRENT = Mode.A;
                    final Mode own = Mode.B;
                    public void run() { use(Holder.CURRENT); use(this.own); use(Mode.A); }
                    static void use(Object o) { }
                }
                """;
        var rows = DumpRun.of(dir, Map.of("demo/Holder.java", holder)).rows("calls");

        assertEquals("field", withArgText(rows, "Holder.CURRENT").path("args").get(0).path("kind").asText(),
                "CURRENT is not final");
        assertNotEquals("constant", withArgText(rows, "this.own").path("args").get(0).path("kind").asText(),
                "own is not static");
        assertEquals("constant", withArgText(rows, "Mode.A").path("args").get(0).path("kind").asText(),
                "an enum constant is one");
    }
}

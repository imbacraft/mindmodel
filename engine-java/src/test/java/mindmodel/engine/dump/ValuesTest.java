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

    /** JLS 4.12.4: a final String with a constant initializer is a constant, static or not; a final Object is never. */
    @Test
    void finalInstanceStringConstantIsAConstantAndAFinalObjectIsNot() throws Exception {
        String source = """
                package demo;
                public class Konst {
                    final String S = "x";
                    static final Object O = "x";
                    void m() { use(S); use(O); }
                    static void use(Object o) { }
                }
                """;
        var run = DumpRun.of(dir, Map.of("demo/Konst.java", source));
        var calls = run.rows("calls");
        JsonNode s = withArgText(calls, "S");
        assertEquals("constant", s.path("args").path(0).path("kind").asText());
        assertEquals("x", s.path("args").path(0).path("value").path("value").asText());
        assertEquals("field", withArgText(calls, "O").path("args").path(0).path("kind").asText(),
                "a final Object is not a constant variable");
        JsonNode objectField = DumpRun.one(run.rows("members"), "name", "O");
        assertEquals(false, objectField.has("value"), "no constant value for a non-constant-variable field");
    }

    /** Binary numeric promotion: a float times an int is a float, folded in float, not in double. */
    @Test
    void floatArithmeticStaysFloat() throws Exception {
        String source = """
                package demo;
                public class Flt {
                    static final float F = 1.1f * 3;
                    static final double D = 1.1 * 3;
                    void m() { use(F); }
                    static void use(float f) { }
                }
                """;
        var run = DumpRun.of(dir, Map.of("demo/Flt.java", source));
        JsonNode f = DumpRun.one(run.rows("members"), "name", "F").path("value");
        assertEquals("float", f.path("kind").asText());
        assertEquals("3.3000002", f.path("value").asText(), "1.1f * 3 is the float 3.3000002, not the double");
        JsonNode d = DumpRun.one(run.rows("members"), "name", "D").path("value");
        assertEquals("double", d.path("kind").asText());
        assertEquals("float", withArgText(run.rows("calls"), "F").path("args").path(0).path("value").path("kind").asText());
    }
}

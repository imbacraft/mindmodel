package mindmodel.engine.model;

import static mindmodel.engine.run.DumpRun.lineOf;
import static org.junit.jupiter.api.Assertions.assertEquals;

import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;
import java.util.Map;

import com.fasterxml.jackson.databind.JsonNode;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import mindmodel.engine.run.DumpRun;

/** types.ndjson and members.ndjson: where each declaration and each annotation is written. */
class PositionsTest {

    @TempDir
    Path dir;

    private static final String OUTER = """
            package demo;

            import java.util.List;

            @Deprecated
            @SuppressWarnings("unchecked")
            public class Outer {
                @Deprecated
                private String name;

                public static class Inner {
                    @Override
                    public String toString() {
                        return "Inner";
                    }
                }
            }
            """;

    private static final Map<String, String> SOURCES = Map.of("demo/Outer.java", OUTER);

    /** The last line of a source: its closing brace, since the fixture ends with one. */
    private static int lastLine(String source) {
        return source.strip().split("\n").length;
    }

    @Test
    void typeLineIsTheDeclarationKeywordAndEndLineIsItsClosingBrace() throws Exception {
        List<JsonNode> types = DumpRun.of(dir, SOURCES).rows("types");

        JsonNode outer = DumpRun.one(types, "fqn", "demo.Outer").path("pos");
        assertEquals(lineOf(OUTER, "public class Outer"), outer.path("line").asInt());
        assertEquals(lastLine(OUTER), outer.path("endLine").asInt());

        JsonNode inner = DumpRun.one(types, "fqn", "demo.Outer.Inner").path("pos");
        assertEquals(lineOf(OUTER, "public static class Inner"), inner.path("line").asInt());
        // Inner closes two lines after its return: the method's brace, then its own.
        assertEquals(lineOf(OUTER, "return \"Inner\";") + 2, inner.path("endLine").asInt());
    }

    @Test
    void annotationsCarryTheLineTheyAreWrittenOn() throws Exception {
        List<JsonNode> types = DumpRun.of(dir, SOURCES).rows("types");
        JsonNode outer = DumpRun.one(types, "fqn", "demo.Outer");

        assertEquals(List.of(lineOf(OUTER, "@Deprecated"), lineOf(OUTER, "@SuppressWarnings")),
                List.of(outer.path("ann").get(0).path("line").asInt(), outer.path("ann").get(1).path("line").asInt()));

        // The field's own annotation sits on the line above the field.
        JsonNode field = DumpRun.one(DumpRun.of(dir, SOURCES).rows("members"), "name", "name");
        assertEquals(lineOf(OUTER, "private String name;") - 1, field.path("ann").get(0).path("line").asInt());
    }

    @Test
    void positionFileIsProjectRelativeForAnyCheckout() throws Exception {
        JsonNode outer = DumpRun.one(DumpRun.of(dir, SOURCES).rows("types"), "fqn", "demo.Outer");

        assertEquals("demo/Outer.java", outer.path("pos").path("file").asText());
    }

    @Test
    void positionFileIsProjectRelativeWhenTheRootIsReachedThroughASymlink() throws Exception {
        // Spoon reports the real path; the root given is the link. Both must meet at the real root.
        Path real = Files.createDirectories(dir.resolve("real"));
        Path link = Files.createSymbolicLink(dir.resolve("link"), real);
        JsonNode outer = DumpRun.one(DumpRun.of(link, SOURCES).rows("types"), "fqn", "demo.Outer");

        assertEquals("demo/Outer.java", outer.path("pos").path("file").asText());
    }

    @Test
    void memberLineAndEndLineSpanItsDeclaration() throws Exception {
        List<JsonNode> members = DumpRun.of(dir, SOURCES).rows("members");

        JsonNode field = DumpRun.one(members, "name", "name").path("pos");
        assertEquals(lineOf(OUTER, "private String name;"), field.path("line").asInt());

        JsonNode method = DumpRun.one(members, "name", "toString").path("pos");
        assertEquals(lineOf(OUTER, "public String toString()"), method.path("line").asInt());
        assertEquals(lineOf(OUTER, "return \"Inner\";") + 1, method.path("endLine").asInt());
    }

    /**
     * Columns are 1-based character offsets in the line, a tab counting as one: a call on the first line is not 0-based,
     * and a tab-indented last line (with no line separator after it) is not expanded to the tabulation size.
     */
    @Test
    void aCallsColumnIsTheOneBasedCharacterOffsetOnFirstAndLastLines() throws Exception {
        String first = "package demo; public class One { void f() { g(); } void g() { } }";
        var run = DumpRun.of(dir.resolve("first"), Map.of("demo/One.java", first));
        JsonNode onFirst = DumpRun.one(run.rows("calls"), "name", "g");
        assertEquals(1, onFirst.path("line").asInt());
        assertEquals(first.indexOf("g();") + 1, onFirst.path("col").asInt(), "1-based, on the first line");

        String last = "package demo;\nclass C {\n\tvoid f() {\n\t\tg();\n\t}\n\tvoid g() {}\n}\n"
                + "\tclass D { void f() { g(); } }";
        var run2 = DumpRun.of(dir.resolve("last"), Map.of("demo/C.java", last));
        int line = DumpRun.lineOf(last, "class D");
        JsonNode onLast = run2.rows("calls").stream().filter(r -> r.path("line").asInt() == line).findFirst()
                .orElseThrow();
        String text = last.split("\n", -1)[line - 1];
        assertEquals(text.indexOf("g();") + 1, onLast.path("col").asInt(), "a tab is one column, not four");
    }
}

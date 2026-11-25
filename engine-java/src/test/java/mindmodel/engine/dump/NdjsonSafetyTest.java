package mindmodel.engine.dump;

import static org.junit.jupiter.api.Assertions.assertEquals;

import java.nio.file.Path;
import java.util.List;
import java.util.Map;

import com.fasterxml.jackson.databind.JsonNode;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

/** Every row is JSON, and one row that holds an odd char never aborts the dump. */
class NdjsonSafetyTest {

    @TempDir
    Path dir;

    private static final String ANN = """
            package demo;
            public @interface Ann { double value() default 0; float f() default 0; String s() default ""; }
            """;

    /** Infinity and NaN are no JSON token: the value is unresolved, and every row still parses. */
    @Test
    void nonFiniteFloatingValuesAreUnresolvedNeverBareTokens() throws Exception {
        String use = """
                package demo;
                @Ann(value = Use.BIG, f = 1e38f * 10f)
                public class Use {
                    static final double BIG = 1e308 * 10;
                    static final double HALF = BIG / 2;
                }
                """;
        var run = DumpRun.of(dir, Map.of("demo/Ann.java", ANN, "demo/Use.java", use));
        JsonNode ann = DumpRun.one(run.rows("types"), "fqn", "demo.Use").path("ann").get(0);
        assertEquals("unresolved", ann.path("args").path("value").path("kind").asText());
        assertEquals("unresolved", ann.path("args").path("f").path("kind").asText());
        for (String section : List.of("types", "members", "calls", "fields", "files", "library"))
            run.rows(section); // each line is read through Jackson: a bare Infinity fails here
    }

    /** A lone surrogate is written as an escape, and decodes back to the same char. */
    @Test
    void aLoneSurrogateInAStringIsEscapedAndTheDumpCompletes() throws Exception {
        String lone = """
                package demo;
                @Ann(s = "\\uD83D")
                public class Lone {
                    void m() { }
                }
                """;
        var run = DumpRun.of(dir, Map.of("demo/Ann.java", ANN, "demo/Lone.java", lone));
        JsonNode ann = DumpRun.one(run.rows("types"), "fqn", "demo.Lone").path("ann").get(0);
        assertEquals("\uD83D", ann.path("args").path("s").path("value").asText());
    }

    /** A call argument cut at 80 code points keeps its emoji whole: the cut is by code point, never by char. */
    @Test
    void aTextCutAcrossAPairIsClippedByCodePointAndTheDumpCompletes() throws Exception {
        String argument = "\"" + "a".repeat(78) + "😀" + "\"";
        String clip = "package demo;\npublic class Clip {\n    void m() { call(" + argument + "); }\n"
                + "    void call(String s) { }\n}\n";
        var run = DumpRun.of(dir, Map.of("demo/Clip.java", clip));
        JsonNode call = DumpRun.one(run.rows("calls"), "name", "call");
        String expected = "\"" + "a".repeat(78) + "😀";
        assertEquals(expected, call.path("args").path(0).path("text").asText());
    }

    /** The writer's escape: a lone half becomes its escape, a pair stays as it is. */
    @Test
    void escapeLoneSurrogatesWritesOnlyTheUnpairedHalves() {
        assertEquals("a\\uD83Db", Ndjson.escapeLoneSurrogates("a\uD83Db"));
        assertEquals("a\\uDE00", Ndjson.escapeLoneSurrogates("a\uDE00"));
        assertEquals("😀", Ndjson.escapeLoneSurrogates("😀"));
    }
}

package mindmodel.engine.dump;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static mindmodel.engine.dump.DumpRun.lineOf;

import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;

import com.fasterxml.jackson.databind.JsonNode;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

/** A body's loops, decision arms and try blocks as line ranges; an anonymous method written once, under its own id. */
class BodyShapesTest {

    @TempDir
    Path dir;

    private static final String LOOPS = """
            package demo;
            public class Loops {
                int total;
                int run(int n) {
                    for (int i = 0; i < n; i++) {
                        if (i > 2) total += i; else total -= 1;
                    }
                    try {
                        total++;
                    } catch (RuntimeException e) {
                        total = 0;
                    } finally {
                        total--;
                    }
                    Runnable r = new Runnable() { public void run() { total++; } };
                    return total;
                }
            }
            """;

    @Test
    void loopsBranchesAndTryBlocksAreLineRanges() throws Exception {
        JsonNode run = DumpRun.one(DumpRun.of(dir, Map.of("demo/Loops.java", LOOPS)).rows("members"), "id",
                "demo.Loops#run(int)");

        JsonNode loop = run.path("loops").get(0);
        assertEquals(lineOf(LOOPS, "for (int i"), loop.path("line").asInt());
        assertEquals(lineOf(LOOPS, "if (i > 2)") + 1, loop.path("endLine").asInt());

        List<String> kinds = new ArrayList<>();
        run.path("branches").forEach(arm -> kinds.add(arm.path("kind").asText()));
        assertEquals(List.of("else", "if", "catch"), kinds);
        assertEquals(lineOf(LOOPS, "if (i > 2)"), run.path("branches").get(1).path("line").asInt());

        JsonNode attempt = run.path("tryBlocks").get(0);
        assertEquals(lineOf(LOOPS, "try {"), attempt.path("line").asInt());
        assertEquals(lineOf(LOOPS, "} catch"), attempt.path("endLine").asInt());
        assertEquals(lineOf(LOOPS, "} finally {"), attempt.path("finallyLine").asInt());
        assertEquals(lineOf(LOOPS, "total--;") + 1, attempt.path("finallyEndLine").asInt());
    }

    @Test
    void anonymousMethodIsWrittenOnceUnderItsLineSuffixedId() throws Exception {
        List<JsonNode> members = DumpRun.of(dir, Map.of("demo/Loops.java", LOOPS)).rows("members");

        List<JsonNode> anonymous = members.stream().filter(m -> m.path("anonymous").asBoolean()).toList();
        assertEquals(1, anonymous.size());
        assertEquals("demo.Loops#run()@" + lineOf(LOOPS, "Runnable r = new Runnable()"),
                anonymous.get(0).path("id").asText());
        assertTrue(anonymous.get(0).path("branches").isArray());
    }
}

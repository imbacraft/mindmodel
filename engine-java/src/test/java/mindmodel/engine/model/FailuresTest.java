package mindmodel.engine.model;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.nio.file.Path;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

import com.fasterxml.jackson.databind.JsonNode;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import mindmodel.engine.run.DumpRun;

/** meta.json counts, and what an unresolvable type reference becomes. */
class FailuresTest {

    @TempDir
    Path dir;

    private static final Map<String, String> CLEAN = Map.of(
            "demo/Shop.java", """
                    package demo;
                    import java.util.List;
                    public class Shop {
                        private List<Order> orders;
                        int count() { return orders.size(); }
                    }
                    """,
            "demo/Order.java", "package demo; public class Order {}");

    /** A field and a call whose type is never imported: nothing in the file says where Widget lives. */
    private static final Map<String, String> MISSING_IMPORT = Map.of(
            "demo/Shop.java", """
                    package demo;
                    public class Shop {
                        private Widget widget;
                        void spin() { widget.turn(); }
                    }
                    """);

    @Test
    void cleanInputWritesNoFailureKeys() throws Exception {
        JsonNode meta = DumpRun.of(dir, CLEAN).meta();

        assertEquals(0, meta.path("counts").path("failedFiles").asInt());
        meta.path("counts").fieldNames().forEachRemaining(key ->
                assertFalse(key.contains("."), "unexpected failure key on clean input: " + key));
    }

    @Test
    void missingImportCallIsAnsweredUnresolvedNotGuessed() throws Exception {
        JsonNode turn = DumpRun.one(DumpRun.of(dir, MISSING_IMPORT).rows("calls"), "name", "turn");

        assertEquals("unresolved", turn.path("origin").asText());
        assertEquals("unresolved-name", turn.path("reason").asText());
        assertEquals(0, turn.path("targets").size());
    }

    /**
     * Each place the dump declines to name Widget is one count: the field's declared type, the read of the field in
     * spin(), and the receiver of turn(). Three refs.typeUnresolved.
     */
    @Test
    void missingImportIsCountedAsARefsFailure() throws Exception {
        Map<String, Integer> counts = new HashMap<>();
        DumpRun.of(dir, MISSING_IMPORT).meta().path("counts").fields()
                .forEachRemaining(e -> counts.put(e.getKey(), e.getValue().asInt()));

        assertEquals(3, counts.getOrDefault("refs.typeUnresolved", 0), "counts: " + counts);
    }

    @Test
    void missingImportFieldKeepsItsWrittenNameAndInventsNoTypeFqn() throws Exception {
        JsonNode widget = DumpRun.one(DumpRun.of(dir, MISSING_IMPORT).rows("members"), "name", "widget");

        assertEquals("Widget", widget.path("type").asText());
        assertTrue(widget.path("typeFqn").isNull(), "typeFqn: " + widget.path("typeFqn"));
    }

    /**
     * A known folder is an exact prefix: a root or a classpath folder with a space in its name is replaced whole, and
     * so is a path under the home directory.
     */
    @Test
    void aKnownFolderWithASpaceInItsNameIsReplacedWhole() {
        Failures.knownPaths(List.of(Path.of("/Users/someone/My Projects/checkout")),
                List.of("/Users/someone/My Libs/lib.jar"));

        assertEquals("NoSuchFileException: <path>: missing", Failures.scrub(
                "NoSuchFileException: /Users/someone/My Projects/checkout/lib/a.jar: missing"));
        assertEquals("see <path>:3 and <path>", Failures.scrub(
                "see /Users/someone/My Projects/checkout/src/A.java:3 and /Users/someone/My Libs/lib.jar"));
        assertEquals("<path>: gone", Failures.scrub("/Users/someone/My Libs/lib.jar: gone"));
        assertEquals("<path> ok", Failures.scrub(System.getProperty("user.home") + "/a.jar ok"));
    }

    /** A message keeps what failed and drops where: an absolute path is replaced, a relative one is kept. */
    @Test
    void anAbsolutePathInAMessageIsScrubbed() {
        assertEquals("NoSuchFileException: <path>: missing",
                Failures.scrub("NoSuchFileException: /Users/someone/checkout/lib.jar: missing"));
        assertEquals("bad <path> here", Failures.scrub("bad C:\\Users\\someone\\a.jar here"));
        assertEquals("see src/demo/a/b.java and 1/2", Failures.scrub("see src/demo/a/b.java and 1/2"));
    }
}

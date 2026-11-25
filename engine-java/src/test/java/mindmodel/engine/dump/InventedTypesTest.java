package mindmodel.engine.dump;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.nio.file.Path;
import java.util.List;
import java.util.Map;

import com.fasterxml.jackson.databind.JsonNode;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

/**
 * A type Spoon invents for a missing import is never named: null wherever a join key goes, the written name kept where
 * the row keeps one, and each place the dump declines to name it counted under refs.typeUnresolved.
 */
class InventedTypesTest {

    @TempDir
    Path dir;

    /** `Widget` has no import and no declaration: Spoon names it in demo, the package of the file that wrote it. */
    private static final Map<String, String> SOURCES = Map.of(
            "demo/Shop.java", """
                    package demo;
                    public class Shop {
                        private Widget widget;
                        Widget make() {
                            Widget w = new Widget();
                            helper(new Widget(), w);
                            widget.turn();
                            return w;
                        }
                        void helper(Object a, Object b) { }
                    }
                    """);

    @Test
    void argumentsAndReceiversOfAnInventedTypeHaveNoTypeButKeepTheirText() throws Exception {
        List<JsonNode> calls = DumpRun.of(dir, SOURCES).rows("calls");

        JsonNode fresh = DumpRun.one(calls, "name", "helper").path("args").get(0);
        assertTrue(fresh.path("typeFqn").isNull(), "typeFqn: " + fresh.path("typeFqn"));
        assertTrue(fresh.path("created").isMissingNode(), "created: " + fresh.path("created"));
        assertEquals("new Widget()", fresh.path("text").asText());

        JsonNode turn = DumpRun.one(calls, "name", "turn");
        assertTrue(turn.path("recv").path("typeFqn").isNull());
        assertEquals("widget", turn.path("recv").path("text").asText());
        assertEquals("unresolved", turn.path("origin").asText());
    }

    @Test
    void aReturnedLocalOfAnInventedTypeHasNoTypeAndNoSource() throws Exception {
        JsonNode make = DumpRun.one(DumpRun.of(dir, SOURCES).rows("members"), "name", "make");
        JsonNode returned = make.path("returned").get(0).path("value");

        assertEquals("w", returned.path("text").asText());
        assertTrue(returned.path("typeFqn").isNull(), "typeFqn: " + returned.path("typeFqn"));
        assertTrue(returned.path("from").isMissingNode(), "from: " + returned.path("from"));
    }

    @Test
    void theInventionsAreCounted() throws Exception {
        JsonNode counts = DumpRun.of(dir, SOURCES).meta().path("counts");

        assertFalse(counts.path("refs.typeUnresolved").isMissingNode());
        assertTrue(counts.path("refs.typeUnresolved").asInt() > 0);
    }
}

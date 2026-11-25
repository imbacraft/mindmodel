package mindmodel.engine.dump;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;

import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;
import java.util.Map;

import com.fasterxml.jackson.databind.JsonNode;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

/**
 * One spelling for a nested type: the dotted join key of types.ndjson (`demo.Outer.In`), never Spoon's `demo.Outer$In`,
 * in every type reference the dump writes.
 */
class NestedSpellingTest {

    @TempDir
    Path dir;

    private static final Map<String, String> SOURCES = Map.of(
            "demo/Outer.java", "package demo; public class Outer { public static class In {"
                    + " public String label() { return \"x\"; } } }",
            "demo/Holder.java", """
                    package demo;
                    import java.util.List;
                    import lombok.Getter;
                    public class Holder {
                        @Getter private Outer.In part;
                        private List<Outer.In> items;
                        Outer.In take(Outer.In arg) {
                            Outer.In x = new Outer.In();
                            take(new Outer.In());
                            take(x);
                            items.size();
                            return x;
                        }
                        String chain(Holder h) { return h.getPart().label(); }
                    }
                    """);

    @Test
    void noSectionSpellsANestedTypeWithADollar() throws Exception {
        DumpRun run = DumpRun.of(dir, SOURCES);

        for (String section : List.of("types", "calls", "members", "fields", "library")) {
            String text = Files.readString(run.out.resolve(section + ".ndjson"));
            assertFalse(text.contains("$"), section + ".ndjson spells a nested type with a dollar sign");
        }
    }

    @Test
    void argumentsKeepTheDottedNameOfANestedType() throws Exception {
        List<JsonNode> takes = calls(DumpRun.of(dir, SOURCES), "take");

        JsonNode fresh = argument(takes, "new").path("args").get(0);
        assertEquals("demo.Outer.In", fresh.path("typeFqn").asText());
        assertEquals("demo.Outer.In", fresh.path("created").asText());

        JsonNode local = argument(takes, "local").path("args").get(0);
        assertEquals("demo.Outer.In", local.path("typeFqn").asText());
        assertEquals("new demo.Outer.In", local.path("from").asText());
    }

    @Test
    void fieldTypeFqnIsTheDottedName() throws Exception {
        JsonNode part = DumpRun.one(DumpRun.of(dir, SOURCES).rows("members"), "name", "part");

        assertEquals("demo.Outer.In", part.path("typeFqn").asText());
    }

    /** A Lombok getter's type starts a chain: the call on its result is typed by the dotted name of the nested type. */
    @Test
    void lombokChainUsesTheDottedName() throws Exception {
        JsonNode label = DumpRun.one(DumpRun.of(dir, SOURCES).rows("calls"), "name", "label");

        assertEquals("demo.Outer.In", label.path("recv").path("typeFqn").asText());
        assertEquals("demo.Outer.In#label()", label.path("targets").get(0).path("id").asText());
    }

    private static List<JsonNode> calls(DumpRun run, String name) throws Exception {
        return run.rows("calls").stream().filter(c -> name.equals(c.path("name").asText())).toList();
    }

    /** The call whose first argument has the given kind; fails when there is no such call. */
    private static JsonNode argument(List<JsonNode> calls, String kind) {
        for (JsonNode call : calls)
            if (kind.equals(call.path("args").get(0).path("kind").asText())) return call;
        throw new AssertionError("no call with a first argument of kind " + kind);
    }
}

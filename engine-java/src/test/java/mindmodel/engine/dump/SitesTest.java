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

/** calls.ndjson: what a call resolves to, and what it does not. */
class SitesTest {

    @TempDir
    Path dir;

    private static final String CALLER = """
            package demo;
            import java.util.ArrayList;
            import java.util.List;
            public class Caller {
                private final Greeter greeter = new Impl();
                String run(String who) {
                    String fixed = Util.clean(who);
                    List<String> names = new ArrayList<>();
                    names.add(fixed);
                    return greeter.greet(fixed);
                }
            }
            """;

    private static final Map<String, String> SOURCES = Map.of(
            "demo/Caller.java", CALLER,
            "demo/Greeter.java", "package demo; public interface Greeter { String greet(String name); }",
            "demo/Impl.java", "package demo; public class Impl implements Greeter {"
                    + " public String greet(String n) { return n; } }",
            "demo/Util.java", "package demo; public class Util { public static String clean(String s) { return s; } }");

    @Test
    void projectStaticCallResolvesToItsDeclaration() throws Exception {
        JsonNode call = DumpRun.one(DumpRun.of(dir, SOURCES).rows("calls"), "name", "clean");

        assertEquals("java", call.path("origin").asText());
        assertEquals(1, call.path("targets").size());
        assertEquals("demo.Util#clean(String)", call.path("targets").get(0).path("id").asText());
        assertEquals("declared", call.path("targets").get(0).path("kind").asText());
    }

    @Test
    void callThroughInterfaceListsEachOverrideAsATarget() throws Exception {
        JsonNode call = DumpRun.one(DumpRun.of(dir, SOURCES).rows("calls"), "name", "greet");

        assertEquals("demo.Greeter#greet(String)", call.path("targets").get(0).path("id").asText());
        assertEquals("demo.Impl#greet(String)", call.path("targets").get(1).path("id").asText());
        assertEquals("declared", call.path("targets").get(0).path("kind").asText());
        assertEquals("override", call.path("targets").get(1).path("kind").asText());
        assertTrue(call.path("uniqueImpl").asBoolean(), "one override of a bodiless method is the implementation");
    }

    @Test
    void callIntoALibraryTypeHasNoProjectTarget() throws Exception {
        JsonNode call = DumpRun.one(DumpRun.of(dir, SOURCES).rows("calls"), "name", "add");

        assertEquals("library", call.path("origin").asText());
        assertEquals(0, call.path("targets").size());
        assertFalse(call.path("uniqueImpl").asBoolean());
    }

    @Test
    void argumentNamesTheCallThatProducedItsValue() throws Exception {
        List<JsonNode> rows = DumpRun.of(dir, SOURCES).rows("calls");
        JsonNode clean = DumpRun.one(rows, "name", "clean");
        JsonNode add = DumpRun.one(rows, "name", "add");

        assertEquals(clean.path("id").asText(), add.path("args").get(0).path("from").asText());
    }
}

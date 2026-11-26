package mindmodel.engine.resolve;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.nio.file.Path;
import java.util.List;
import java.util.Map;

import com.fasterxml.jackson.databind.JsonNode;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import mindmodel.engine.run.DumpRun;

/**
 * A call on a project type that names a method no project type declares, where a supertype is outside the checkout, is
 * a library call. The project's own declaration wins when one exists, and a project hierarchy with no library supertype
 * keeps the call unresolved.
 */
class InheritedLibraryCallsTest {

    @TempDir
    Path dir;

    /** `Bookings` extends a library interface (`Store`, not in the checkout) and declares nothing. */
    private static final String USE = """
            package demo;
            import org.example.Store;
            public class Use {
                String byId(Bookings bookings) { return bookings.findById(1L); }
                String project(Child child) { return child.name(); }
                String loose(Loose loose) { return loose.missing(); }
            }
            """;

    private static final Map<String, String> SOURCES = Map.of(
            "demo/Bookings.java", "package demo; import org.example.Store;"
                    + " public interface Bookings extends Store<String> { }",
            "demo/Parent.java", "package demo; public class Parent { public String name() { return \"p\"; } }",
            "demo/Child.java", "package demo; import org.example.Store;"
                    + " public class Child extends Parent implements Store<String> { }",
            "demo/Loose.java", "package demo; public class Loose { public String known() { return \"k\"; } }",
            "demo/Use.java", USE);

    private static JsonNode callOn(List<JsonNode> calls, int line, String name) {
        return calls.stream().filter(r -> r.path("line").asInt() == line && name.equals(r.path("name").asText()))
                .findFirst().orElseThrow(() -> new AssertionError("no " + name + " call on line " + line));
    }

    /** `findById` is declared by the library supertype: a library call with no target, not an unresolved one. */
    @Test
    void aMethodOnlyALibrarySupertypeDeclaresIsALibraryCall() throws Exception {
        var run = DumpRun.of(dir, SOURCES);
        JsonNode call = callOn(run.rows("calls"), DumpRun.lineOf(USE, "byId"), "findById");
        assertEquals("library", call.path("origin").asText());
        assertEquals(0, call.path("targets").size(), "a library method has no declaration in the checkout");
        assertEquals("library-signature", call.path("reason").asText());
    }

    /** `name` is declared by a project superclass, so the project declaration answers and the call is java. */
    @Test
    void aProjectDeclarationOfTheMethodWinsOverTheLibrarySupertype() throws Exception {
        var run = DumpRun.of(dir, SOURCES);
        JsonNode call = callOn(run.rows("calls"), DumpRun.lineOf(USE, "project"), "name");
        assertEquals("java", call.path("origin").asText());
        assertEquals("demo.Parent#name()", call.path("targets").get(0).path("id").asText());
    }

    /** A project hierarchy with no library supertype cannot be answered by a library: it stays unresolved. */
    @Test
    void aMethodNoSupertypeDeclaresStaysUnresolved() throws Exception {
        var run = DumpRun.of(dir, SOURCES);
        JsonNode call = callOn(run.rows("calls"), DumpRun.lineOf(USE, "loose"), "missing");
        assertEquals("unresolved", call.path("origin").asText());
        assertEquals("no-declaration-here", call.path("reason").asText());
        assertTrue(call.path("targets").isEmpty());
    }
}

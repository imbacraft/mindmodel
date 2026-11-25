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

/** A `new` that creates an anonymous subclass reaches the superclass's constructor the subclass calls. */
class ConstructorTargetsTest {

    @TempDir
    Path dir;

    /** The `<init>` call row on the given source line. */
    private static JsonNode newOn(List<JsonNode> calls, int line) {
        return calls.stream().filter(r -> r.path("line").asInt() == line && "<init>".equals(r.path("name").asText()))
                .findFirst().orElseThrow(() -> new AssertionError("no <init> call on line " + line));
    }

    @Test
    void anEnumConstantWithABodyReachesTheEnumsOwnConstructor() throws Exception {
        String source = """
                package demo;
                public enum State {
                    NEW("new"),
                    DONE("done") {
                        @Override public boolean terminal() { return true; }
                    };
                    private final String code;
                    State(String code) { this.code = code; }
                    public boolean terminal() { return false; }
                }
                """;

        List<JsonNode> calls = DumpRun.of(dir, Map.of("demo/State.java", source)).rows("calls");

        JsonNode done = newOn(calls, DumpRun.lineOf(source, "DONE(\"done\")"));
        assertEquals("demo.State#State(String)", done.path("targets").get(0).path("id").asText());
        assertEquals("java", done.path("origin").asText());
    }

    @Test
    void aNewOfAnAnonymousSubclassWithArgumentsReachesTheSuperclassConstructorOfThatArity() throws Exception {
        String source = """
                package demo;
                public class Base {
                    public Base(int n) { }
                    public Base() { }
                    public Object make() {
                        return new Base(7) { public String toString() { return "x"; } };
                    }
                }
                """;

        List<JsonNode> calls = DumpRun.of(dir, Map.of("demo/Base.java", source)).rows("calls");

        JsonNode made = newOn(calls, DumpRun.lineOf(source, "return new Base(7)"));
        assertEquals(1, made.path("targets").size(), "one constructor of arity one");
        assertEquals("demo.Base#Base(int)", made.path("targets").get(0).path("id").asText());
        assertTrue(made.path("recv").path("typeFqn").asText().equals("demo.Base"));
    }
}

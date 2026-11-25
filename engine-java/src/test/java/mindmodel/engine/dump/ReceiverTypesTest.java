package mindmodel.engine.dump;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNull;

import java.nio.file.Path;
import java.util.List;
import java.util.Map;

import com.fasterxml.jackson.databind.JsonNode;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

/** The receiver type of a call: a type parameter is the type argument its target was declared with, never the name. */
class ReceiverTypesTest {

    @TempDir
    Path dir;

    private static final String CACHE = """
            package demo;
            public class Cache<Value> {
                public Value value;
                public Value get(String k) { return value; }
                public <T> T pick(T t) { return t; }
            }
            """;

    private static final String FOO = "package demo; public class Foo { public void bar() { } }";

    private static final String USE = """
            package demo;
            public class Use {
                void bound(Cache<Foo> c) { c.get("a").bar(); }
                void field(Cache<Foo> c) { c.value.bar(); }
                void wildcard(Cache<? extends Foo> c) { c.get("a").bar(); }
                void raw(Cache c) { c.get("a").bar(); }
                void method(Cache<Foo> c) { c.pick(new Foo()).bar(); }
            }
            """;

    /** The row of the call named {@code name} written on the given source line. */
    private static JsonNode callOn(List<JsonNode> calls, int line, String name) {
        return calls.stream().filter(r -> r.path("line").asInt() == line && name.equals(r.path("name").asText()))
                .findFirst().orElseThrow(() -> new AssertionError("no " + name + " call on line " + line));
    }

    @Test
    void aTypeArgumentBindsTheReceiverOfACallOnAGenericTarget() throws Exception {
        var run = DumpRun.of(dir, Map.of("demo/Cache.java", CACHE, "demo/Foo.java", FOO, "demo/Use.java", USE));
        List<JsonNode> calls = run.rows("calls");
        int bound = DumpRun.lineOf(USE, "void bound");
        assertEquals("demo.Foo", callOn(calls, bound, "bar").path("recv").path("type").asText());
        int wildcard = DumpRun.lineOf(USE, "void wildcard");
        assertEquals("demo.Foo", callOn(calls, wildcard, "bar").path("recv").path("type").asText(),
                "? extends Foo has Foo as its upper bound");
        int field = DumpRun.lineOf(USE, "void field");
        assertEquals("demo.Foo", callOn(calls, field, "bar").path("recv").path("type").asText(),
                "a field of type Value is bound by its target's type argument too");
        // pick(T) is bound by the method, not by Cache's type argument: it is never a Value, and never a bare T.
        int method = DumpRun.lineOf(USE, "void method");
        String picked = callOn(calls, method, "bar").path("recv").path("type").textValue();
        assertFalse("T".equals(picked) || "Value".equals(picked), "a method's type variable is no receiver");
    }

    @Test
    void aTypeVariableWithNoBindingIsNeverAReceiver() throws Exception {
        var run = DumpRun.of(dir, Map.of("demo/Cache.java", CACHE, "demo/Foo.java", FOO, "demo/Use.java", USE));
        List<JsonNode> calls = run.rows("calls");
        int raw = DumpRun.lineOf(USE, "void raw");
        JsonNode bar = callOn(calls, raw, "bar");
        assertNull(bar.path("recv").path("type").textValue(), "a raw target binds nothing: unknown, not Value");
        for (JsonNode call : calls) assertFalse("Value".equals(call.path("recv").path("type").textValue()));
    }

    /**
     * A library type whose simple name is two capitals is still a receiver: a chain's receiver is its static type (the
     * `ID` a call returns), not the class that declares the method it calls (`Base`, which `ID` extends).
     */
    @Test
    void aLibraryTypeWithAShortUpperCaseNameIsAReceiver() throws Exception {
        Path classes = DumpRun.compile(dir, Map.of(
                "lib/Base.java", "package lib; public class Base { public void go() { } }",
                "lib/ID.java", "package lib; public class ID extends Base { }"));
        String source = """
                package demo;
                import lib.ID;
                public class Short {
                    ID make() { return null; }
                    void chain() { make().go(); }
                }
                """;
        var run = DumpRun.of(dir.resolve("run"), Map.of("demo/Short.java", source), List.of("demo/Short.java"), 17,
                List.of(classes.toString()));
        int chain = DumpRun.lineOf(source, "void chain");
        assertEquals("lib.ID", callOn(run.rows("calls"), chain, "go").path("recv").path("type").asText());
    }
}

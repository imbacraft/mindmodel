package mindmodel.engine.write;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.nio.file.Path;
import java.util.List;
import java.util.Map;

import com.fasterxml.jackson.databind.JsonNode;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import mindmodel.engine.run.DumpRun;

/** calls.ndjson: what a call resolves to, and what it does not. */
class CallsWriterTest {

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

    /**
     * A call in a chain is written at its own method name, not at the start of the chain: each `.name(` is its own
     * call on its own line.
     */
    @Test
    void aChainedCallIsPlacedAtItsOwnMethodName() throws Exception {
        String source = """
                package demo;
                public class Chain {
                    Result make() {
                        return Result.builder()
                                .label("(")
                                .provider(null)
                                .attempts(1)
                                .build();
                    }
                }
                """;
        String result = "package demo; public class Result { public static Builder builder() { return new Builder(); }"
                + " public static class Builder { public Builder provider(String p) { return this; }"
                + " public Builder label(String l) { return this; }"
                + " public Builder attempts(int n) { return this; } public Result build() { return new Result(); } } }";
        var run = DumpRun.of(dir, Map.of("demo/Chain.java", source, "demo/Result.java", result));
        List<JsonNode> calls = run.rows("calls");
        int line = DumpRun.lineOf(source, ".provider(null)");
        JsonNode provider = DumpRun.one(calls, "name", "provider");
        assertEquals(line, provider.path("line").asInt());
        assertEquals(source.split("\n", -1)[line - 1].indexOf("provider") + 1, provider.path("col").asInt());
        JsonNode build = DumpRun.one(calls, "name", "build");
        int buildLine = DumpRun.lineOf(source, ".build()");
        assertEquals(buildLine, build.path("line").asInt());
        assertEquals(source.split("\n", -1)[buildLine - 1].indexOf("build") + 1, build.path("col").asInt());
    }

    /** A call inside a cast is placed at its own method name, like any other call. */
    @Test
    void aCallInsideACastIsPlacedAtItsMethodName() throws Exception {
        String source = """
                package demo;
                import java.util.Map;
                public class Cast {
                    int quantity(Map<String, Object> m) {
                        return ((Number) m.get("quantity")).intValue();
                    }
                }
                """;
        JsonNode get = DumpRun.one(DumpRun.of(dir, Map.of("demo/Cast.java", source)).rows("calls"), "name", "get");
        String text = source.split("\n", -1)[get.path("line").asInt() - 1];
        assertEquals(text.indexOf("get(") + 1, get.path("col").asInt());
    }

    /** A varargs call names the member the dump writes for it, so the call's target is a lookup. */
    @Test
    void aVarargsCallTargetsTheIdTheMemberRowWrites() throws Exception {
        String util = """
                package demo;
                public class Util {
                    public static String firstNonBlank(String... values) { return values[0]; }
                }
                """;
        String caller = """
                package demo;
                public class Caller {
                    String pick(String a) { return Util.firstNonBlank(a, "b", "c"); }
                }
                """;
        var run = DumpRun.of(dir, Map.of("demo/Util.java", util, "demo/Caller.java", caller));
        String member = DumpRun.one(run.rows("members"), "name", "firstNonBlank").path("id").asText();
        JsonNode call = DumpRun.one(run.rows("calls"), "name", "firstNonBlank");
        assertEquals(member, call.path("targets").get(0).path("id").asText());
        assertEquals("demo.Util#firstNonBlank(String[])", member);
    }

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

    private static List<String> targetIds(JsonNode call) {
        List<String> out = new java.util.ArrayList<>();
        for (JsonNode t : call.path("targets")) out.add(t.path("id").asText());
        return out;
    }

    /**
     * The row a call sits on, found by its method and name: field initialisers and blocks have no member of their own.
     */
    private static JsonNode inMethod(List<JsonNode> rows, String method, String name) {
        List<JsonNode> hits = rows.stream().filter(r -> method.equals(r.path("method").asText())
                && name.equals(r.path("name").asText())).toList();
        if (hits.size() != 1) throw new AssertionError(name + " in " + method + " matched " + hits.size() + " rows");
        return hits.get(0);
    }

    @Test
    void overrideIsTheSubtypeMethodWithTheSameSignature() throws Exception {
        Map<String, String> sources = Map.of(
                "demo/Sink.java", "package demo; public interface Sink { void take(String s); }",
                "demo/Impl.java", "package demo; public class Impl implements Sink {"
                        + " public void take(Integer i) {} public void take(String s) {} }",
                "demo/Use.java", "package demo; public class Use { void f(Sink sink) { sink.take(\"x\"); } }");

        JsonNode call = DumpRun.one(DumpRun.of(dir, sources).rows("calls"), "name", "take");

        assertEquals(List.of("demo.Sink#take(String)", "demo.Impl#take(String)"), targetIds(call));
    }

    @Test
    void overrideOfAGenericDeclarationIsStillFound() throws Exception {
        Map<String, String> sources = Map.of(
                "demo/Store.java", "package demo; public interface Store<T> { void put(T item); }",
                "demo/Mem.java", "package demo; public class Mem implements Store<String> {"
                        + " public void put(String item) {} }",
                "demo/Use.java", "package demo; public class Use { void f(Store<String> s) { s.put(\"x\"); } }");

        JsonNode call = DumpRun.one(DumpRun.of(dir, sources).rows("calls"), "name", "put");

        assertEquals(List.of("demo.Store#put(T)", "demo.Mem#put(String)"), targetIds(call));
    }

    @Test
    void recordAccessorIsTheOverrideOfAnInterfaceMethod() throws Exception {
        Map<String, String> sources = Map.of(
                "demo/Named.java", "package demo; public interface Named { String name(); }",
                "demo/Person.java", "package demo; public record Person(String name) implements Named {}",
                "demo/Use.java", "package demo; public class Use { String f(Named n) { return n.name(); } }");

        JsonNode call = DumpRun.one(DumpRun.of(dir, sources).rows("calls"), "name", "name");

        assertEquals(List.of("demo.Named#name()", "demo.Person#name()"), targetIds(call));
    }

    @Test
    void initialisersBlocksAndConstructorCallsGetCallRows() throws Exception {
        Map<String, String> sources = Map.of(
                "demo/Factory.java", "package demo; public class Factory {"
                        + " public static Factory create() { return new Factory(); }"
                        + " public Factory() {} public Factory(String s) {} static void warm() {} }",
                "demo/Init.java", """
                        package demo;
                        public class Init {
                            static final Factory SHARED = Factory.create();
                            private final Factory own = Factory.create();
                            static { Factory.warm(); }
                            { Factory.warm(); }
                            public Init() {}
                        }
                        """,
                "demo/Mode.java", "package demo; public enum Mode { A(Factory.create());"
                        + " final Factory f; Mode(Factory f) { this.f = f; } }",
                "demo/Use.java", "package demo; public class Use { Factory f() { return new Factory(\"a\"); } }");
        List<JsonNode> rows = DumpRun.of(dir, sources).rows("calls");

        assertEquals("demo.Init#<clinit>()", inMethod(rows, "demo.Init#<clinit>()", "create").path("method").asText());
        assertEquals("demo.Init#<init>()", inMethod(rows, "demo.Init#<init>()", "create").path("method").asText());
        assertEquals("demo.Init#<clinit>()", inMethod(rows, "demo.Init#<clinit>()", "warm").path("method").asText());
        assertEquals("demo.Init#<init>()", inMethod(rows, "demo.Init#<init>()", "warm").path("method").asText());
        assertEquals("demo.Mode#<clinit>()", inMethod(rows, "demo.Mode#<clinit>()", "create").path("method").asText());

        JsonNode made = rows.stream().filter(r -> "demo.Use#f()".equals(r.path("method").asText())).findFirst()
                .orElseThrow(() -> new AssertionError("no call row in Use.f"));
        assertEquals(List.of("demo.Factory#Factory(String)"), targetIds(made));
        assertEquals(1, made.path("argc").asInt());
    }

    @Test
    void anonymousClassCallHasExactlyOneRow() throws Exception {
        String outer = """
                package nested;
                public class Outer {
                    public class Inner { public String hello() { return "hi"; } }
                    public Runnable anonymous() {
                        class Local { int n() { return 1; } }
                        return new Runnable() {
                            @Override
                            public void run() { new Local().n(); }
                        };
                    }
                }
                """;
        List<JsonNode> rows = DumpRun.of(dir, Map.of("nested/Outer.java", outer)).rows("calls");

        List<JsonNode> hits = rows.stream().filter(r -> "n".equals(r.path("name").asText())).toList();
        assertEquals(1, hits.size(), "one call site, one row");
        assertEquals("nested.Outer#anonymous()", hits.get(0).path("method").asText());
    }

    @Test
    void fieldAccessInsideAnAnonymousClassHasOneRow() throws Exception {
        String outer = """
                package demo;
                public class Outer {
                    int hits;
                    Runnable f() { return new Runnable() { public void run() { hits = hits + 1; } }; }
                }
                """;
        List<JsonNode> fields = DumpRun.of(dir, Map.of("demo/Outer.java", outer)).rows("fields");

        List<JsonNode> hits = fields.stream().filter(r -> "demo.Outer#hits".equals(r.path("field").asText())).toList();
        assertEquals(2, hits.size(), "one read and one write of hits, each one row");
        assertEquals(1, hits.stream().filter(r -> "write".equals(r.path("op").asText())).count());
    }

    @Test
    void unqualifiedCallInAnAnonymousClassIsNotResolvedAgainstTheEnclosingClass() throws Exception {
        String outer = """
                package demo;
                public class Outer {
                    void setName(String s) {}
                    void f() { new Thread() { void g() { setName("x"); } }; }
                    void h() { new Thread() { void g() { this.setName("y"); } }; }
                }
                """;
        List<JsonNode> calls = DumpRun.of(dir, Map.of("demo/Outer.java", outer)).rows("calls").stream()
                .filter(r -> "setName".equals(r.path("name").asText())).toList();

        for (JsonNode call : calls) {
            assertEquals(List.of(), targetIds(call), "Thread's setName is a library method");
            assertEquals("java.lang.Thread", call.path("recv").path("typeFqn").asText(),
                    "the receiver is the anonymous class's supertype, never Outer and never an empty package");
        }
    }

    @Test
    void methodReferenceArityComesFromTheReferencedMethod() throws Exception {
        Map<String, String> sources = Map.of(
                "demo/Foo.java", "package demo; public class Foo { public Foo() {} public Foo(String s) {} }",
                "demo/Refs.java", """
                        package demo;
                        import java.util.Comparator;
                        import java.util.function.Function;
                        public class Refs {
                            Foo make() { Function<String, Foo> f = Foo::new; return f.apply("a"); }
                            int cmp() { Comparator<Integer> c = Integer::compare; return c.compare(1, 2); }
                        }
                        """);
        List<JsonNode> refs = DumpRun.of(dir, sources).rows("calls").stream()
                .filter(r -> "methodRef".equals(r.path("via").asText())).toList();

        JsonNode ctor = refs.stream().filter(r -> targetIds(r).contains("demo.Foo#Foo(String)")).findFirst()
                .orElseThrow(() -> new AssertionError("Foo::new does not reach Foo(String)"));
        assertEquals(1, ctor.path("argc").asInt());
        JsonNode compare = DumpRun.one(refs, "name", "compare");
        assertEquals(2, compare.path("argc").asInt());
    }

    /**
     * `new` of a Lombok constructor reaches the member Lombok wrote, and says so. Spoon also has an implicit default
     * constructor for these classes; a call with arguments must not be answered by it.
     */
    @Test
    void newOfLombokConstructorTargetsTheSynthesisedMember() throws Exception {
        Map<String, String> sources = Map.of(
                "demo/Pair.java", """
                        package demo;
                        import lombok.AllArgsConstructor;
                        @AllArgsConstructor public class Pair { int a; String b; }
                        """,
                "demo/Name.java", """
                        package demo;
                        import lombok.RequiredArgsConstructor;
                        @RequiredArgsConstructor public class Name { private final String value; int hits; }
                        """,
                "demo/Use.java", """
                        package demo;
                        public class Use {
                            Object run() { return new Pair(1, "x"); }
                            Object name() { return new Name("n"); }
                        }
                        """);
        List<JsonNode> calls = DumpRun.of(dir, sources).rows("calls");

        JsonNode pair = newAt(calls, "new Pair(1, \"x\")");
        assertEquals("lombok", pair.path("origin").asText());
        assertEquals(List.of("demo.Pair#Pair(int,String)"), targetIds(pair));
        JsonNode name = newAt(calls, "new Name(\"n\")");
        assertEquals("lombok", name.path("origin").asText());
        assertEquals(List.of("demo.Name#Name(String)"), targetIds(name));
    }

    /** The `new` row whose written text is `text`. */
    private static JsonNode newAt(List<JsonNode> calls, String text) {
        return calls.stream().filter(c -> text.equals(c.path("recv").path("text").asText())).findFirst()
                .orElseThrow(() -> new AssertionError("no new row for " + text));
    }
}

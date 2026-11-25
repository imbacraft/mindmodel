package mindmodel.engine.run;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.io.IOException;
import java.io.StringWriter;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;

import com.fasterxml.jackson.core.JsonFactory;
import com.fasterxml.jackson.core.JsonGenerator;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import spoon.reflect.code.CtInvocation;
import spoon.reflect.declaration.CtType;
import spoon.reflect.visitor.filter.TypeFilter;

import mindmodel.engine.model.Failures;
import mindmodel.engine.model.Positions;
import mindmodel.engine.model.SourceModel;
import mindmodel.engine.resolve.FieldAccess;
import mindmodel.engine.resolve.Refs;
import mindmodel.engine.write.CallsWriter;
import mindmodel.engine.write.FieldsWriter;
import mindmodel.engine.write.LibraryWriter;
import mindmodel.engine.write.Ndjson;

/**
 * The dump's conventions (docs/dump-spec.md, Conventions), checked on one fixture that writes every row kind. A rule
 * that breaks here is a change a reader would notice: an empty string where null applies, an unknown key, an unsorted
 * section, a label with no text. The error rows are written directly, since a fixture cannot make Spoon fail.
 */
class DumpConventionsTest {

    @TempDir
    static Path dir;

    private static final ObjectMapper JSON = new ObjectMapper();

    private static final String LIB = """
            package lib;
            public class Holder<T> extends java.util.AbstractList<T> implements Comparable<Holder<T>> {
                public T value;
                public static final ThreadLocal<String> CTX = new ThreadLocal<>();
                public T get(int i) { return value; }
                public int size() { return 0; }
                public int compareTo(Holder<T> o) { return 0; }
            }
            """;

    /**
     * Every row kind: declarations of each kind, Lombok and compiler members, bodies with every decision, calls of each
     * kind, field accesses, annotations, an unresolved type and a default-package file.
     */
    private static final Map<String, String> SOURCES = Map.of(
            "demo/Kinds.java", """
                    package demo;

                    import java.util.List;
                    import java.util.function.Supplier;
                    import lib.Holder;
                    import lombok.Data;
                    import lombok.extern.slf4j.Slf4j;

                    interface Port {
                        int ping(String s);
                    }

                    @interface Mark {
                        String value() default "x";
                    }

                    enum Level implements Port {
                        LOW(1), HIGH(2);

                        private final int weight;

                        Level(int weight) {
                            this.weight = weight;
                        }

                        public int ping(String s) {
                            return weight;
                        }
                    }

                    record Pair(String left, int right) {
                        Pair {
                            if (left == null) throw new IllegalArgumentException("left");
                        }
                    }

                    abstract class Base<E> {
                        protected E seed;
                        abstract String name();
                    }

                    @Slf4j
                    @Data
                    @Mark
                    class Box<T> extends Base<String> implements Port {
                        public static final int LIMIT = 3 * 4;
                        static final String NAME = "box";
                        private final T held;
                        private String label;
                        private List<Pair> pairs;
                        private int count;
                        Missing missing;
                        Holder<String> lib;

                        Box(T held) {
                            this.held = held;
                        }

                        @Override
                        String name() {
                            return NAME;
                        }

                        public int ping(String s) {
                            return LIMIT;
                        }

                        @Mark("z")
                        String describe(Object o) {
                            int n = 0;
                            for (int i = 0; i < 2; i++) n++;
                            if (o == null) return "none";
                            else n++;
                            try {
                                n += Integer.parseInt(String.valueOf(o));
                            } catch (NumberFormatException e) {
                                n = -1;
                            } finally {
                                n++;
                            }
                            String word = switch ((Object) n) {
                                case Integer i when i > 5 -> "big";
                                case Integer i -> "small";
                                default -> "other";
                            };
                            String tag = switch (o) {
                                case String s -> s;
                                case Pair(String l, int r) -> l;
                                case null, default -> "x";
                            };
                            String level;
                            switch (n) {
                                case 1:
                                    level = "one";
                                    break;
                                default:
                                    level = "many";
                            }
                            return word + tag + level;
                        }

                        String pick(int n) {
                            return switch (n) {
                                case 1 -> "one";
                                default -> "other";
                            };
                        }

                        String wire(List<String> items) {
                            Supplier<String> s = new Supplier<String>() {
                                public String get() {
                                    return helper();
                                }
                            };
                            Runnable r = () -> helper();
                            List<String> out = items.stream().map(String::trim).toList();
                            Pair p = new Pair("a", 1);
                            int m = Math.max(1, 2);
                            label = out.get(0).trim();
                            this.count += 1;
                            mystery.call();
                            Object seen = lib.value;
                            Holder.CTX.get();
                            return s.get() + p.left() + m + held + seen;
                        }

                        String helper() {
                            return "h";
                        }
                    }
                    """,
            "demo/Broken.java", """
                    package demo;
                    class Broken {
                        void f( {
                        }
                    }
                    """,
            "Plain.java", """
                    class Plain {
                        static final String TAG = "plain";
                    }
                    """);

    private static DumpRun run;
    private static List<JsonNode> types;
    private static List<JsonNode> members;
    private static List<JsonNode> calls;
    private static List<JsonNode> fields;
    private static List<JsonNode> library;
    private static List<JsonNode> files;

    @BeforeAll
    static void dumpTheFixture() throws Exception {
        Path classes = DumpRun.compile(dir, Map.of("lib/Holder.java", LIB));
        run = DumpRun.of(dir.resolve("run"), SOURCES,
                List.of("demo/Kinds.java", "demo/Broken.java", "Plain.java"), 21, List.of(classes.toString()));
        types = run.rows("types");
        members = run.rows("members");
        calls = run.rows("calls");
        fields = run.rows("fields");
        library = run.rows("library");
        files = run.rows("files");
    }

    // ---- the rules, on the fixture ----

    /** One shape per row kind, the same in the fixture and in every error row: unknown keys fail, missing ones fail. */
    @Test
    void everyRowKindHasItsKeysAndNoOthers() {
        for (JsonNode row : types) {
            keys(row, "types", "fqn kind modifiers enclosing typeParams supertypes ann pos");
            for (JsonNode s : row.path("supertypes")) keys(s, "supertype", "kind type typeFqn");
        }
        for (JsonNode row : members) checkMember(row);
        for (JsonNode row : calls) checkCall(row);
        for (JsonNode row : fields) checkField(row);
        for (JsonNode row : library) checkLibrary(row);
        for (JsonNode row : files) checkFile(row);
    }

    /** No row carries an empty string: an unknown value is null. Checked on every section, nested values included. */
    @Test
    void noEmptyStringAnywhere() throws IOException {
        for (String section : List.of("types", "members", "calls", "fields", "library", "files")) {
            for (JsonNode row : run.rows(section))
                assertNoEmptyString(row, section);
        }
    }

    /** Each section sorted by its stated key, and calls grouped by method in source order within it. */
    @Test
    void everySectionIsInItsStatedOrder() {
        assertSorted("types", types, r -> List.of(r.path("pos").path("file").asText(),
                r.path("pos").path("line").asInt(), r.path("pos").path("col").asInt(), r.path("fqn").asText()));
        assertSorted("fields", fields, r -> List.of(r.path("file").asText(), r.path("line").asInt(),
                r.path("col").asInt(), r.path("op").asText(),
                r.path("field").isNull() ? "" : r.path("field").asText()));
        assertSorted("library", library, r -> List.of(r.path("fqn").asText()));
        assertSorted("files", files, r -> List.of(r.path("path").asText()));
        assertMembersGroupedByOwnerInTypeOrder();
        assertCallsGroupedByMethodInSourceOrder();
        for (JsonNode file : files) {
            List<String> names = new ArrayList<>();
            for (JsonNode i : file.path("imports")) names.add(i.path("name").asText());
            assertEquals(sorted(names), names, "imports of " + file.path("path").asText() + " are sorted by name");
        }
        for (JsonNode member : members) {
            // A switch's returns are in source order, and so are a body's entries: by line, then column.
            int last = -1;
            for (JsonNode entry : member.path("returned")) {
                int at = entry.path("line").asInt() * 100000 + entry.path("col").asInt();
                assertTrue(at >= last, "returned entries are in source order in " + member.path("name").asText());
                last = at;
            }
        }
    }

    /** Null where a type is unknown: a type variable, an invented type, a receiver the dump cannot name. */
    @Test
    void unknownTypesAreNullNotEmpty() {
        JsonNode held = member("Box", "held");
        assertTrue(held.path("typeFqn").isNull(), "a type variable names no type");
        assertEquals("T", held.path("type").asText());
        assertTrue(member("Box", "missing").path("typeFqn").isNull(), "an invented type names no type");
        assertEquals("demo.Base", types("Box").path("supertypes").get(0).path("typeFqn").asText());
        assertEquals("Base<String>", types("Box").path("supertypes").get(0).path("type").asText());
        JsonNode unknownCall = call("call");
        assertEquals("unresolved", unknownCall.path("origin").asText(), "mystery is no declared name");
    }

    /** Type-pattern and record-pattern labels are written from their own parts, with their guard in `guard`. */
    @Test
    void patternLabelsHaveTheirText() {
        JsonNode describe = member("Box", "describe");
        JsonNode word = returned(describe, "word");
        assertEquals("Integer i", word.path("arms").get(0).path("labels").get(0).asText());
        assertEquals("i > 5", word.path("arms").get(0).path("guard").asText());
        assertTrue(word.path("arms").get(2).path("default").asBoolean(), "default is an arm with no labels");
        JsonNode tag = returned(describe, "tag");
        assertEquals("String s", tag.path("arms").get(0).path("labels").get(0).asText());
        assertEquals("Pair(String l, int r)", tag.path("arms").get(1).path("labels").get(0).asText());
        JsonNode both = tag.path("arms").get(2);
        assertEquals("null", both.path("labels").get(0).asText(), "the null label is written as the literal it is");
        assertEquals(1, both.path("labels").size(), "case null, default holds only the null label");
        assertTrue(both.path("default").asBoolean(), "case null, default is a default arm");
    }

    /** The fixture writes every row kind the rules are checked against, so no rule passes by writing nothing. */
    @Test
    void theFixtureWritesEveryRowKind() {
        assertEquals(Set.of("class", "interface", "enum", "record", "annotation"), kindsOf(types, "kind"));
        assertEquals(Set.of("field", "enumConstant", "recordComponent", "method", "constructor"),
                kindsOf(members, "kind"));
        assertEquals(Set.of("lombok", "compiler", "record"), kindsOf(members, "generated"));
        assertEquals(Set.of("call", "methodRef", "new"), kindsOf(calls, "kind"));
        assertEquals(Set.of("read", "write"), kindsOf(fields, "op"));
        assertEquals(Set.of("return", "switch"), kindsOfNested(members, "returned", "kind"));
        assertEquals(Set.of("if", "else", "catch", "case"), kindsOfNested(members, "branches", "kind"));
        assertTrue(kindsOf(calls, "origin").containsAll(Set.of("java", "library", "unresolved")),
                "calls answered by the checkout, by the library, and not at all");
        assertFalse(library.isEmpty(), "a classpath type is written");
        assertTrue(members.stream().anyMatch(m -> m.path("tryBlocks").toString().contains("finallyLine")),
                "a try with a finalizer is written with its lines");
        assertTrue(files.stream().anyMatch(f -> f.path("errors").size() > 0), "a file error is written");
        assertTrue(types.stream().anyMatch(t -> t.path("supertypes").size() == 2),
                "a class with a superclass and an interface");
    }

    private static Set<String> kindsOf(List<JsonNode> rows, String key) {
        Set<String> out = new HashSet<>();
        for (JsonNode row : rows) if (row.has(key) && !row.path(key).isNull()) out.add(row.path(key).asText());
        return out;
    }

    private static Set<String> kindsOfNested(List<JsonNode> rows, String array, String key) {
        Set<String> out = new HashSet<>();
        for (JsonNode row : rows)
            for (JsonNode item : row.path(array)) if (item.has(key)) out.add(item.path(key).asText());
        return out;
    }

    // ---- error rows: the same shape as their section's rows ----

    /** A call Spoon could not type, written by the call writer itself. */
    @Test
    void errorRowsHaveTheShapeOfTheirSection() throws Exception {
        Path root = dir.resolve("run").resolve("src");
        Positions positions = new Positions(root);
        CtInvocation<?> found = helperCall(SourceModel.build(root, List.of("demo/Kinds.java"), 21));
        assertTrue(found != null, "the fixture calls helper()");
        CtInvocation<?> helper = found;
        JsonNode call = writeRow(g -> CallsWriter.errorRow(g, "demo.Box#wire(List<String>)",
                "demo.Box#wire(List<String>)@1:1", helper, positions.of(helper), new IllegalStateException("boom"),
                new Failures()));
        checkCall(call);
        assertEquals("error", call.path("origin").asText());
        assertTrue(call.path("reason").asText().startsWith("IllegalStateException"));
        assertEquals("call", call.path("kind").asText());
        assertEquals("helper", call.path("name").asText());
        assertTrue(call.path("recv").path("typeFqn").isNull());
        assertTrue(call.path("targets").isEmpty());

        JsonNode field = writeRow(g -> FieldsWriter.errorRow(g,
                new FieldAccess.Row("demo.Box#wire(List<String>)", "demo.Box#label", false, "write",
                        positions.of(helper), Refs.Ref.plain("label", "field", null), List.of()),
                new IllegalStateException("boom")));
        checkField(field);
        assertEquals("error", field.path("origin").asText());
        assertEquals("error", field.path("value").path("reason").asText());

        JsonNode library = writeRow(g -> LibraryWriter.unreadable(g, "lib.Broken", new IllegalStateException("boom")));
        checkLibrary(library);
        assertEquals("error", library.path("origin").asText());
        assertTrue(library.path("kind").isNull(), "nothing was read, so the kind is unknown");
    }

    // ---- the fixture's own facts the rules depend on ----

    @Test
    void fileProblemsCarryTheirKindAndLine() {
        JsonNode broken = file("demo/Broken.java");
        JsonNode error = broken.path("errors").get(0);
        assertEquals("syntax", error.path("kind").asText());
        assertTrue(error.path("line").isInt(), "a syntax error names its line: " + error);
        assertTrue(file("Plain.java").path("package").isNull(), "the default package is null, not empty");
        assertEquals(0, file("demo/Kinds.java").path("errors").size());
    }

    @Test
    void generatedAndRecordMembersHaveTheSameKeysAsDeclaredOnes() {
        JsonNode getter = member("Box", "getLabel");
        assertEquals("lombok", getter.path("generated").asText());
        assertEquals("Getter", getter.path("generatedBy").asText());
        JsonNode log = member("Box", "log");
        assertEquals("org.slf4j.Logger", log.path("typeFqn").asText());
        assertEquals("lombok", log.path("generated").asText());
        JsonNode accessor = memberOfKind("Pair", "left", "method");
        assertEquals("record", accessor.path("generated").asText());
        assertTrue(accessor.path("generatedBy").isNull());
        assertEquals("compiler", member("Level", "values").path("generated").asText());
        assertFalse(member("Box", "held").has("generated"), "a declared member has no generated key");
    }

    // ---- checks ----

    private static void checkMember(JsonNode row) {
        String kind = row.path("kind").asText();
        switch (kind) {
            case "field" -> keys(row, "field", "kind owner name type typeFqn modifiers ann pos",
                    "value generated generatedBy");
            case "enumConstant" -> keys(row, "enumConstant", "kind owner name ann pos args");
            case "recordComponent" -> keys(row, "recordComponent", "kind owner name type typeFqn ann pos");
            case "method" -> {
                keys(row, "method", "kind owner name params id returns isMain modifiers hasBody anonymous throws ann "
                        + "loops branches tryBlocks returned pos", "generated generatedBy");
                checkExecutableBody(row);
            }
            case "constructor" -> {
                keys(row, "constructor", "kind owner name params id modifiers hasBody anonymous throws ann "
                        + "loops branches tryBlocks returned pos", "generated generatedBy");
                checkExecutableBody(row);
            }
            default -> throw new AssertionError("a member of no known kind: " + row);
        }
        if (row.has("generated")) assertTrue(row.has("generatedBy"), "a generated row says what wrote it: " + row);
        for (JsonNode p : row.path("params")) keys(p, "param", "type name varargs ann");
        for (JsonNode a : row.path("ann")) keys(a, "annotation", "name raw line args");
        if (row.path("ann").size() > 0)
            for (JsonNode a : row.path("ann")) assertTrue(a.path("line").isNull() || a.path("line").asInt() > 0,
                    "an annotation's line is null when unknown, never 0");
    }

    private static void checkExecutableBody(JsonNode row) {
        for (JsonNode loop : row.path("loops")) keys(loop, "loop", "line endLine");
        for (JsonNode branch : row.path("branches")) keys(branch, "branch", "line endLine kind");
        for (JsonNode block : row.path("tryBlocks")) {
            keys(block, "tryBlock", "line endLine", "finallyLine finallyEndLine");
            assertEquals(block.has("finallyLine"), block.has("finallyEndLine"), "a finalizer has both lines or none");
        }
        for (JsonNode entry : row.path("returned")) {
            if ("switch".equals(entry.path("kind").asText())) {
                keys(entry, "returned switch", "kind line col form on arms", "target");
                for (JsonNode arm : entry.path("arms")) {
                    keys(arm, "arm", "labels default value", "guard");
                    checkRef(arm.path("value"));
                }
            } else {
                keys(entry, "returned return", "kind line col value");
                checkRef(entry.path("value"));
            }
        }
    }

    private static void checkCall(JsonNode row) {
        keys(row, "call", "method id file line col kind name argc recv targets uniqueImpl args inLambda origin",
                "via reason");
        keys(row.path("recv"), "recv", "typeFqn typeArgs kind how text");
        for (JsonNode t : row.path("targets")) keys(t, "target", "id kind");
        for (JsonNode arg : row.path("args")) checkRef(arg);
        if ("error".equals(row.path("origin").asText())) assertTrue(row.has("reason"), "an error row says why");
    }

    private static void checkField(JsonNode row) {
        keys(row, "field access", "method field static op kind typeArgs file line col origin value", "reason");
        assertTrue(List.of("java", "unresolved", "error").contains(row.path("origin").asText()),
                "a field row's origin: " + row);
        checkRef(row.path("value"));
    }

    /** One expression: `value` is `{kind, value}` or absent; `inLambda` is there for parameters and only them. */
    private static void checkRef(JsonNode ref) {
        if (ref.isMissingNode() || ref.isNull()) return;
        keys(ref, "expression", "text kind typeFqn",
                "value field call from index inLambda created reason then otherwise");
        if (ref.has("value")) keys(ref.path("value"), "folded value", "kind value");
        assertEquals("param".equals(ref.path("kind").asText()), ref.has("inLambda"),
                "inLambda is written for a parameter and only for one: " + ref);
    }

    private static void checkLibrary(JsonNode row) {
        keys(row, "library", "fqn kind origin supers fields methods", "reason");
        for (JsonNode s : row.path("supers")) keys(s, "library supertype", "kind type typeFqn");
        for (JsonNode f : row.path("fields")) keys(f, "library field", "name type typeFqn modifiers");
        for (JsonNode m : row.path("methods")) {
            keys(m, "library method", "name returns params modifiers");
            for (JsonNode p : m.path("params")) keys(p, "library param", "type name varargs");
        }
    }

    private static void checkFile(JsonNode row) {
        keys(row, "file", "path package imports importsOrigin test errors", "importsReason");
        for (JsonNode i : row.path("imports")) keys(i, "import", "name wildcard static");
        for (JsonNode e : row.path("errors")) keys(e, "file error", "kind reason line");
    }

    /** The row's keys are exactly the required ones plus the optional ones the caller allows. */
    private static void keys(JsonNode row, String what, String required, String optional) {
        Set<String> names = fieldNames(row);
        Set<String> allowed = new HashSet<>(List.of(required.split(" ")));
        allowed.addAll(List.of(optional.isEmpty() ? new String[0] : optional.split(" ")));
        for (String key : required.split(" ")) assertTrue(names.contains(key), what + " lacks " + key + ": " + names);
        for (String name : names) assertTrue(allowed.contains(name), what + " has an unknown key " + name + ": " + row);
    }

    private static void keys(JsonNode row, String what, String required) {
        keys(row, what, required, "");
    }

    private static Set<String> fieldNames(JsonNode row) {
        Set<String> names = new HashSet<>();
        row.fieldNames().forEachRemaining(names::add);
        return names;
    }

    private static void assertNoEmptyString(JsonNode node, String where) {
        if (node.isTextual()) assertFalse(node.asText().isEmpty(), where + " writes an empty string: " + node);
        if (node.isContainerNode())
            for (JsonNode child : node) assertNoEmptyString(child, where);
    }

    private static void assertSorted(String section, List<JsonNode> rows,
            java.util.function.Function<JsonNode, List<?>> key) {
        for (int i = 1; i < rows.size(); i++) {
            List<?> before = key.apply(rows.get(i - 1));
            List<?> after = key.apply(rows.get(i));
            assertTrue(compare(before, after) <= 0,
                section + " is out of order at row " + i + ": " + before + " > " + after);
        }
    }

    @SuppressWarnings({"unchecked", "rawtypes"})
    private static int compare(List<?> a, List<?> b) {
        for (int i = 0; i < a.size(); i++) {
            int c = ((Comparable) a.get(i)).compareTo(b.get(i));
            if (c != 0) return c;
        }
        return 0;
    }

    /** Members: the owners come in types.ndjson order, and within one owner by position. */
    private static void assertMembersGroupedByOwnerInTypeOrder() {
        List<String> typeOrder = new ArrayList<>();
        for (JsonNode t : types) typeOrder.add(t.path("fqn").asText());
        List<String> owners = new ArrayList<>();
        for (JsonNode m : members) {
            String owner = m.path("owner").asText();
            if (owners.isEmpty() || !owners.get(owners.size() - 1).equals(owner)) owners.add(owner);
        }
        assertEquals(sorted(owners, typeOrder), owners, "members are grouped by owner in types order");
        // Within an owner, by position: a row with no position last.
        JsonNode previous = null;
        for (JsonNode m : members) {
            if (previous != null && previous.path("owner").asText().equals(m.path("owner").asText())) {
                assertTrue(position(previous) <= position(m), "members of " + m.path("owner").asText()
                        + " are in position order: " + previous.path("name").asText() + ", " + m.path("name").asText());
            }
            previous = m;
        }
    }

    /** A position as one number, with a row that has none placed after every row that has one. */
    private static long position(JsonNode row) {
        if (row.path("pos").isNull()) return Long.MAX_VALUE;
        return row.path("pos").path("line").asLong() * 100000 + row.path("pos").path("col").asLong();
    }

    /** Calls: the calls of one body are one block, and inside it in source order. */
    private static void assertCallsGroupedByMethodInSourceOrder() {
        Set<String> ended = new HashSet<>();
        JsonNode previous = null;
        for (JsonNode call : calls) {
            String method = call.path("method").asText();
            if (previous == null || !method.equals(previous.path("method").asText())) {
                if (previous != null) ended.add(previous.path("method").asText());
                assertFalse(ended.contains(method), "the calls of " + method + " are one block");
            } else {
                assertTrue(position(previous) <= position(call), "calls of " + method + " are in source order");
            }
            previous = call;
        }
    }

    private static List<String> sorted(List<String> values) {
        List<String> copy = new ArrayList<>(values);
        copy.sort(null);
        return copy;
    }

    private static List<String> sorted(List<String> values, List<String> order) {
        List<String> out = new ArrayList<>();
        for (String name : order) if (values.contains(name)) out.add(name);
        return out;
    }

    private static JsonNode member(String owner, String name) {
        for (JsonNode m : members)
            if (owner.equals(simple(m.path("owner").asText())) && name.equals(m.path("name").asText())) return m;
        throw new AssertionError("no member " + owner + "." + name);
    }

    /** A member by owner, name and kind: a record component and its accessor share a name. */
    private static JsonNode memberOfKind(String owner, String name, String kind) {
        for (JsonNode m : members)
            if (owner.equals(simple(m.path("owner").asText())) && name.equals(m.path("name").asText())
                    && kind.equals(m.path("kind").asText())) return m;
        throw new AssertionError("no " + kind + " " + owner + "." + name);
    }

    private static JsonNode types(String simple) {
        for (JsonNode t : types) if (simple.equals(simple(t.path("fqn").asText()))) return t;
        throw new AssertionError("no type " + simple);
    }

    private static JsonNode call(String name) {
        for (JsonNode c : calls) if (name.equals(c.path("name").asText())) return c;
        throw new AssertionError("no call " + name);
    }

    private static JsonNode returned(JsonNode member, String target) {
        for (JsonNode entry : member.path("returned"))
            if (target.equals(entry.path("target").asText())) return entry;
        throw new AssertionError("no switch assigning " + target);
    }

    private static JsonNode file(String path) {
        for (JsonNode f : files) if (path.equals(f.path("path").asText())) return f;
        throw new AssertionError("no file " + path);
    }

    private static CtInvocation<?> helperCall(SourceModel model) {
        for (CtType<?> t : model.allTypes())
            for (CtInvocation<?> call : t.getElements(new TypeFilter<>(CtInvocation.class)))
                if ("helper".equals(call.getExecutable().getSimpleName())) return call;
        return null;
    }

    private static String simple(String fqn) {
        return fqn.substring(fqn.lastIndexOf('.') + 1);
    }

    /** A row written by a row writer, read back as JSON. */
    private static JsonNode writeRow(Ndjson.Body body) throws IOException {
        StringWriter text = new StringWriter();
        try (JsonGenerator g = new JsonFactory().createGenerator(text)) {
            g.writeStartObject();
            body.write(g);
            g.writeEndObject();
        }
        return JSON.readTree(text.toString());
    }
}

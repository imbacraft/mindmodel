package mindmodel.engine.write;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.io.IOException;
import java.nio.file.Path;
import java.util.List;
import java.util.Map;

import com.fasterxml.jackson.databind.JsonNode;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import mindmodel.engine.run.DumpRun;

/** fields.ndjson: whether a field read is static, including fields declared outside the checkout. */
class FieldsWriterTest {

    @TempDir
    Path dir;

    /** A library static field is static whether it is named through its type, or through a static import. */
    @Test
    void libraryStaticFieldsAreStatic() throws Exception {
        String source = """
                package demo;
                import static java.lang.Math.PI;
                public class Reads {
                    int inst;
                    void f(Reads other) {
                        Object a = System.out;
                        Object b = Integer.MAX_VALUE;
                        Object c = PI;
                        Object d = other.inst;
                    }
                }
                """;
        List<JsonNode> fields = DumpRun.of(dir, Map.of("demo/Reads.java", source)).rows("fields");

        assertEquals(true, readOf(fields, "System.out").path("static").asBoolean(), "System.out");
        assertEquals(true, readOf(fields, "Integer.MAX_VALUE").path("static").asBoolean(), "Integer.MAX_VALUE");
        assertEquals(true, readOf(fields, "PI").path("static").asBoolean(), "PI (static import)");
        assertEquals(false, readOf(fields, "other.inst").path("static").asBoolean(), "an instance field");
    }

    /** A static import names its owner: the field it brings in is static, though the owner is not in the checkout. */
    @Test
    void staticImportsAreStaticWithoutADeclaration() throws Exception {
        String source = """
                package demo;
                import static com.nowhere.Consts.MAX;
                import static com.nowhere.Util.*;
                public class Imp {
                    int f() { return MAX + OTHER; }
                }
                """;
        DumpRun run = DumpRun.of(dir, Map.of("demo/Imp.java", source));
        List<JsonNode> fields = run.rows("fields");
        assertEquals(true, readOf(fields, "MAX").path("static").asBoolean(), "MAX (single static import)");
        assertEquals(true, readOf(fields, "OTHER").path("static").asBoolean(), "OTHER (on-demand static import)");
        assertEquals(0, unreadable(run), "no static import is an unknown modifier");
    }

    /** `@Slf4j` writes `private static final Logger log`: the logger is static, and no declaration says so. */
    @Test
    void lombokLoggerIsStatic() throws Exception {
        String source = """
                package demo;
                import lombok.extern.slf4j.Slf4j;
                @Slf4j
                public class Svc {
                    void f() { log.info("x"); }
                }
                """;
        DumpRun run = DumpRun.of(dir, Map.of("demo/Svc.java", source));
        List<JsonNode> fields = run.rows("fields");
        assertEquals(true, readOf(fields, "log").path("static").asBoolean(), "the Lombok logger field");
        assertEquals(0, unreadable(run));
    }

    /** An unqualified enum constant in a case label is static. The selector's type is unknown, the name is not. */
    @Test
    void enumConstantCaseLabelIsStatic() throws Exception {
        String source = """
                package demo;
                public class Sw {
                    enum Status { ACTIVE, TRIAL }
                    int f(Lib lib) {
                        switch (lib.status()) {
                            case ACTIVE: return 1;
                            default: return 0;
                        }
                    }
                }
                """;
        DumpRun run = DumpRun.of(dir, Map.of("demo/Sw.java", source));
        List<JsonNode> fields = run.rows("fields");
        assertEquals(true, readOf(fields, "ACTIVE").path("static").asBoolean(), "ACTIVE is a constant of Status");
        assertEquals(0, unreadable(run));
    }

    /** A bare name with no declaration and no static import could be anything: static is unknown, and it is counted. */
    @Test
    void unknownBareNameIsStaticNull() throws Exception {
        String source = """
                package demo;
                public class Bare {
                    Object f() { return mystery; }
                }
                """;
        DumpRun run = DumpRun.of(dir, Map.of("demo/Bare.java", source));
        assertTrue(readOf(run.rows("fields"), "mystery").path("static").isNull(), "static is unknown");
        assertEquals(1, unreadable(run));
    }

    /** `files.length` is the array's own instance field: not static, and knowable without a classpath. */
    @Test
    void arrayLengthIsAnInstanceFieldAndIsNotCounted() throws Exception {
        String source = """
                package demo;
                public class Arr {
                    int f(Foo[] files) { return files.length; }
                }
                """;
        DumpRun run = DumpRun.of(dir, Map.of("demo/Arr.java", source));
        JsonNode length = readOf(run.rows("fields"), "files.length");
        assertEquals(false, length.path("static").asBoolean(), "length is instance");
        assertEquals(0, unreadable(run));
    }

    /** A field read through a receiver of a type outside the checkout is unknown: the library may declare it static. */
    @Test
    void libraryFieldOfUnknownReceiverIsStaticNull() throws Exception {
        String source = """
                package demo;
                public class Lf {
                    int f(Lib lib) { return lib.count; }
                }
                """;
        DumpRun run = DumpRun.of(dir, Map.of("demo/Lf.java", source));
        assertTrue(readOf(run.rows("fields"), "lib.count").path("static").isNull(), "static is unknown");
        assertEquals(1, unreadable(run));
    }

    /** A field declared in the checkout is instance when it has no `static`, even with no modifier at all. */
    @Test
    void declaredPackagePrivateFieldIsInstance() throws Exception {
        String source = """
                package demo;
                public class Plain {
                    int plain;
                    int f() { return plain; }
                }
                """;
        DumpRun run = DumpRun.of(dir, Map.of("demo/Plain.java", source));
        assertEquals(false, readOf(run.rows("fields"), "plain").path("static").asBoolean());
        assertEquals(0, unreadable(run));
    }

    /**
     * A library superclass may declare a field of the same name, and an inherited field shadows a static import: so the
     * import does not decide it, and the answer is unknown.
     */
    @Test
    void staticImportUnderALibrarySuperclassIsStaticNull() throws Exception {
        String source = """
                package demo;
                import static com.nowhere.Util.*;
                public class Sub extends com.nowhere.Base {
                    int f() { return OTHER; }
                }
                """;
        DumpRun run = DumpRun.of(dir, Map.of("demo/Sub.java", source));
        assertTrue(readOf(run.rows("fields"), "OTHER").path("static").isNull(), "an inherited field may shadow it");
        assertEquals(1, unreadable(run));
    }

    /** A case label that names no enum constant of the checkout is a constant the dump cannot place: unknown. */
    @Test
    void unknownCaseLabelIsStaticNull() throws Exception {
        String source = """
                package demo;
                public class Cl {
                    int f(Lib lib) {
                        switch (lib.code()) {
                            case LIMIT: return 1;
                            default: return 0;
                        }
                    }
                }
                """;
        DumpRun run = DumpRun.of(dir, Map.of("demo/Cl.java", source));
        assertTrue(readOf(run.rows("fields"), "LIMIT").path("static").isNull(), "LIMIT is no checkout enum constant");
        assertEquals(1, unreadable(run));
    }

    /**
     * A method-reference qualifier that names a type is a type, not a field: an imported type, a nested type of a checkout
     * type, and a Lombok builder (`@Builder` writes `<Owner>Builder`). None of them gets a fields row.
     */
    @Test
    void methodReferenceTypeQualifierHasNoFieldRow() throws Exception {
        String source = """
                package demo;
                import com.nowhere.Session;
                import lombok.Builder;
                import java.util.function.Function;
                @Builder
                public class Mr {
                    static class Helper { static String run(Object o) { return ""; } }
                    Function<Object, String> a() { return Session::getId; }
                    Function<Object, String> b() { return Mr.Helper::run; }
                    Function<Object, Mr> c() { return Mr.MrBuilder::build; }
                }
                """;
        DumpRun run = DumpRun.of(dir, Map.of("demo/Mr.java", source));
        for (JsonNode field : run.rows("fields")) {
            String text = field.path("value").path("text").asText("");
            assertFalse(text.equals("Session") || text.startsWith("Mr.Helper") || text.startsWith("Mr.MrBuilder")
                    || text.equals("Helper") || text.equals("MrBuilder"), "a type qualifier has no field row: " + field);
        }
        assertEquals(0, unreadable(run));
    }

    /** A real field used as a method-reference qualifier is a field read: its row stays, with its static flag. */
    @Test
    void fieldMethodReferenceQualifierKeepsItsRow() throws Exception {
        String source = """
                package demo;
                import java.util.function.Supplier;
                public class Fq {
                    Object field;
                    static Object shared;
                    Supplier<String> a() { return field::toString; }
                    Supplier<String> b() { return shared::toString; }
                }
                """;
        DumpRun run = DumpRun.of(dir, Map.of("demo/Fq.java", source));
        assertEquals(false, readOf(run.rows("fields"), "field").path("static").asBoolean(), "an instance field");
        assertEquals(true, readOf(run.rows("fields"), "shared").path("static").asBoolean(), "a static field");
    }

    /** A bare name no source declares and no import names, used as a qualifier, may be a variable: its row stays. */
    @Test
    void unknownMethodReferenceQualifierKeepsItsRow() throws Exception {
        String source = """
                package demo;
                import java.util.function.Supplier;
                public class Uq {
                    Supplier<String> a() { return mystery::toString; }
                }
                """;
        DumpRun run = DumpRun.of(dir, Map.of("demo/Uq.java", source));
        assertTrue(readOf(run.rows("fields"), "mystery").path("static").isNull(), "a variable we cannot see");
        assertEquals(1, unreadable(run));
    }

    /** The count of accesses whose static flag could not be read. */
    private static int unreadable(DumpRun run) throws IOException {
        return run.meta().path("counts").path("fields.modifiersUnreadable").asInt(0);
    }

    /** The access row whose value is written as `text`. */
    private static JsonNode readOf(List<JsonNode> fields, String text) {
        List<JsonNode> hits = fields.stream().filter(f -> text.equals(f.path("value").path("text").asText())).toList();
        if (hits.size() != 1) throw new AssertionError(text + " matched " + hits.size() + " field rows");
        return hits.get(0);
    }

    /** A compound write stores the old value combined with the right-hand side: never the right-hand side alone. */
    @Test
    void compoundAssignmentIsUnresolvedNotItsRightHandSide() throws Exception {
        String source = """
                package demo;
                public class Acc {
                    int total;
                    void add(int amount) {
                        this.total += amount;
                        this.total = amount;
                    }
                }
                """;
        List<JsonNode> fields = DumpRun.of(dir, Map.of("demo/Acc.java", source)).rows("fields");
        JsonNode compound = fields.stream().filter(r -> r.path("line").asInt() == DumpRun.lineOf(source, "+="))
                .findFirst().orElseThrow();
        assertEquals("unresolved", compound.path("value").path("kind").asText());
        assertEquals("compound-assignment", compound.path("value").path("reason").asText());
        assertEquals("this.total += amount", compound.path("value").path("text").asText());
        JsonNode plain = fields.stream().filter(r -> r.path("line").asInt() == DumpRun.lineOf(source, "this.total = "))
                .findFirst().orElseThrow();
        assertEquals("param", plain.path("value").path("kind").asText());
    }

    /** `X.class` is a class literal, not a field: it has no field row, and as an argument it is no field either. */
    @Test
    void classLiteralIsNotAFieldAccess() throws Exception {
        String source = """
                package demo;
                public class Lit {
                    void m() { use(String.class); use(Lit.class); }
                    static void use(Object o) { }
                }
                """;
        var run = DumpRun.of(dir, Map.of("demo/Lit.java", source));
        for (JsonNode field : run.rows("fields"))
            assertFalse(field.path("value").path("text").asText("").endsWith(".class"), "no field row: " + field);
        for (JsonNode call : run.rows("calls"))
            if ("use".equals(call.path("name").asText()))
                for (JsonNode arg : call.path("args")) assertEquals("other", arg.path("kind").asText());
    }
}

package mindmodel.engine.write;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;

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

package mindmodel.engine.dump;

import static org.junit.jupiter.api.Assertions.assertEquals;

import java.nio.file.Path;
import java.util.List;
import java.util.Map;

import com.fasterxml.jackson.databind.JsonNode;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

/** fields.ndjson: whether a field read is static, including fields declared outside the checkout. */
class FieldAccessesTest {

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
}

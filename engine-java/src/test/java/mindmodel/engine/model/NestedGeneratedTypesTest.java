package mindmodel.engine.model;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;

import java.nio.file.Path;
import java.util.List;
import java.util.Map;

import com.fasterxml.jackson.databind.JsonNode;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import mindmodel.engine.run.DumpRun;

/**
 * A nested type of an annotation-processor source is in the model for resolution. Spoon's getAllTypes() gives top-level
 * types only, so the nested one must be found by walking the types, or a call into it is not resolved.
 */
class NestedGeneratedTypesTest {

    @TempDir
    Path dir;

    @Test
    void aCallIntoANestedGeneratedTypeResolvesToItsDeclaration() throws Exception {
        Map<String, String> sources = Map.of(
                "gen/demo/Outer.java", "package demo; public class Outer { public static class Inner {"
                        + " public String name() { return \"x\"; } } }",
                "demo/Use.java", "package demo; public class Use { String f() { return new Outer.Inner().name(); } }");

        DumpRun run = DumpRun.of(dir, sources, List.of("demo/Use.java"), SourceModel.compliance(), List.of(),
                List.of("gen"));

        JsonNode name = DumpRun.one(run.rows("calls"), "name", "name");
        assertEquals(1, name.path("targets").size(), name.toString());
        assertEquals("demo.Outer.Inner#name()", name.path("targets").get(0).path("id").asText());
        assertEquals("java", name.path("origin").asText(), name.toString());
        assertEquals("demo.Outer.Inner", name.path("recv").path("typeFqn").asText());
        assertFalse(run.rows("library").stream().anyMatch(r -> "demo.Outer.Inner".equals(r.path("fqn").asText())),
                "a type the checkout declares is not a library type");
    }
}

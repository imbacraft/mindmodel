package mindmodel.engine.dump;

import static org.junit.jupiter.api.Assertions.assertEquals;

import java.nio.file.Path;
import java.util.Map;

import com.fasterxml.jackson.databind.JsonNode;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

/** Two files that declare the same type name: the dump keeps one row and says so in the run's counts. */
class DuplicateTypesTest {

    @TempDir
    Path dir;

    @Test
    void aSecondDeclarationOfTheSameNameIsCountedNotSilentlyDropped() throws Exception {
        Map<String, String> sources = Map.of(
                "mod1/demo/Dup.java", "package demo; public class Dup { public void one() {} }",
                "mod2/demo/Dup.java", "package demo; public class Dup { public void two() {} }");

        DumpRun run = DumpRun.of(dir, sources);

        long rows = run.rows("types").stream().filter(t -> "demo.Dup".equals(t.path("fqn").asText())).count();
        assertEquals(1, rows, "a type name keys one row: ids cannot tell the two apart");
        JsonNode counts = run.meta().path("counts");
        assertEquals(1, counts.path("types.duplicateFqn").asInt(), "the second declaration is reported");
    }
}

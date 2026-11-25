package mindmodel.engine.write;

import static org.junit.jupiter.api.Assertions.assertEquals;

import java.nio.file.Path;
import java.util.List;
import java.util.Map;

import com.fasterxml.jackson.databind.JsonNode;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import mindmodel.engine.run.DumpRun;

/** A record's canonical constructor is written once, whatever spelling the author gave its parameter types. */
class RecordTypesTest {

    @TempDir
    Path dir;

    @Test
    void canonicalConstructorWrittenWithAnotherSpellingIsNotDuplicated() throws Exception {
        String source = """
                package demo;
                public class Use {
                    record P(java.lang.String name) {
                        P(String name) { this.name = name; }
                    }
                }
                """;
        List<JsonNode> members = DumpRun.of(dir, Map.of("demo/Use.java", source)).rows("members");
        long constructors = members.stream()
                .filter(r -> "constructor".equals(r.path("kind").asText()))
                .filter(r -> "demo.Use.P".equals(r.path("owner").asText()))
                .count();
        assertEquals(1, constructors, "the declared canonical constructor answers for the record's; no second one");
    }
}

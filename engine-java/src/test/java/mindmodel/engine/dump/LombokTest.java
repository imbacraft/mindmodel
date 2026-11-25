package mindmodel.engine.dump;

import static org.junit.jupiter.api.Assertions.assertEquals;

import java.nio.file.Path;
import java.util.Map;

import com.fasterxml.jackson.databind.JsonNode;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

/** The members Lombok writes say which annotation wrote them. */
class LombokTest {

    @TempDir
    Path dir;

    @Test
    void toStringSaysItIsGeneratedByToString() throws Exception {
        String source = """
                package demo;
                import lombok.ToString;
                @ToString
                public class Tagged { int x; }
                """;

        JsonNode toString = DumpRun.one(DumpRun.of(dir, Map.of("demo/Tagged.java", source)).rows("members"),
                "name", "toString");

        assertEquals("ToString", toString.path("generatedBy").asText());
    }
}

package mindmodel.engine.resolve;

import static org.junit.jupiter.api.Assertions.assertEquals;

import java.nio.file.Path;
import java.util.List;
import java.util.Map;

import com.fasterxml.jackson.databind.JsonNode;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import mindmodel.engine.run.DumpRun;

/**
 * A variable read inside a lambda names the enclosing method's parameter or local, and takes that declaration's
 * type. The type comes from the written import, so it resolves without a classpath.
 */
class LambdaCaptureTest {

    @TempDir
    Path dir;

    private static final String SOURCE = """
            package demo;
            import org.example.Environment;
            import org.example.Runner;
            public class Capture {
                Runner param(Environment env) {
                    return args -> {
                        String value = env.getProperty("a", "b");
                    };
                }
                Runner local(Environment outer) {
                    Environment env = outer;
                    return args -> {
                        String value = env.getProperty("c", "d");
                    };
                }
            }
            """;

    private static JsonNode getPropertyOn(List<JsonNode> calls, int line) {
        return calls.stream()
                .filter(r -> r.path("line").asInt() == line && "getProperty".equals(r.path("name").asText()))
                .findFirst().orElseThrow(() -> new AssertionError("no getProperty call on line " + line));
    }

    @Test
    void aParameterCapturedByALambdaHasTheParametersType() throws Exception {
        var run = DumpRun.of(dir, Map.of("demo/Capture.java", SOURCE));
        JsonNode call = getPropertyOn(run.rows("calls"), DumpRun.lineOf(SOURCE, "env.getProperty(\"a\""));
        assertEquals("org.example.Environment", call.path("recv").path("typeFqn").asText());
        assertEquals("param", call.path("recv").path("how").asText());
    }

    @Test
    void aLocalCapturedByALambdaHasTheLocalsType() throws Exception {
        var run = DumpRun.of(dir, Map.of("demo/Capture.java", SOURCE));
        JsonNode call = getPropertyOn(run.rows("calls"), DumpRun.lineOf(SOURCE, "env.getProperty(\"c\""));
        assertEquals("org.example.Environment", call.path("recv").path("typeFqn").asText());
        assertEquals("local", call.path("recv").path("how").asText());
    }
}

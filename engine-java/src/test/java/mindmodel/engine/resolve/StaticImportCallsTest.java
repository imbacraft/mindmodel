package mindmodel.engine.resolve;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.nio.file.Path;
import java.util.Map;

import com.fasterxml.jackson.databind.JsonNode;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import mindmodel.engine.run.DumpRun;

/**
 * An unqualified call Spoon cannot answer, to a name a static import brings from a library type, is a library call. A
 * method of that name in an enclosing type of the call wins: it is the project's.
 */
class StaticImportCallsTest {

    @TempDir
    Path dir;

    private static final String USE = """
            package demo;
            import static org.example.Verify.verify;
            import static org.example.Matchers.*;
            public class Use {
                void single(Object x) { verify(x); }
                void wildcard(Object x) { any(x); }
                void project(Object x) { local(x); }
                void local(Object x) { }
            }
            """;

    /** A file with no static import: a name no declaration gives stays unresolved there. */
    private static final String PLAIN = """
            package demo;
            public class Plain {
                void unknown(Object x) { nowhere(x); }
            }
            """;

    private JsonNode call(String name) throws Exception {
        return DumpRun.one(DumpRun.of(dir, Map.of("demo/Use.java", USE, "demo/Plain.java", PLAIN)).rows("calls"),
                "name", name);
    }

    @Test
    void aSingleStaticImportOfALibraryMethodIsALibraryCall() throws Exception {
        JsonNode verify = call("verify");
        assertEquals("library", verify.path("origin").asText());
        assertEquals("library-signature", verify.path("reason").asText());
        assertTrue(verify.path("targets").isEmpty());
    }

    @Test
    void anOnDemandStaticImportOfALibraryTypeCoversItsMethods() throws Exception {
        JsonNode any = call("any");
        assertEquals("library", any.path("origin").asText());
        assertEquals("library-signature", any.path("reason").asText());
    }

    @Test
    void aNameNoImportGivesStaysUnresolved() throws Exception {
        JsonNode nowhere = call("nowhere");
        assertEquals("unresolved", nowhere.path("origin").asText());
        assertEquals("no-declaration-here", nowhere.path("reason").asText());
    }

    @Test
    void aMethodOfTheEnclosingTypeWinsOverAStaticImport() throws Exception {
        JsonNode local = call("local");
        assertEquals("java", local.path("origin").asText());
        assertEquals("demo.Use#local(Object)", local.path("targets").get(0).path("id").asText());
    }
}

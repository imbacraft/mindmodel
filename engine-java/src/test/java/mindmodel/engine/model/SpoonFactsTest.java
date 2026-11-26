package mindmodel.engine.model;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.nio.file.Path;
import java.util.List;
import java.util.Map;

import com.fasterxml.jackson.databind.JsonNode;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import mindmodel.engine.run.DumpRun;

/**
 * Spoon behaviour SPOON.md records as a risk the engine must not fall into. Each test passes on the current code: the
 * risk does not reach the dump, and the test keeps it that way.
 */
class SpoonFactsTest {

    @TempDir
    Path dir;

    /** A type in the default package is named by its simple name, never `unnamed package.Plain`. */
    @Test
    void aTypeInTheDefaultPackageIsNamedWithoutAPackage() throws Exception {
        DumpRun run = DumpRun.of(dir, Map.of("Plain.java", "public class Plain { void go() {} }"));

        assertEquals("Plain", run.rows("types").get(0).path("fqn").asText());
        assertEquals("Plain", DumpRun.one(run.rows("members"), "id", "Plain#go()").path("owner").asText());
    }

    /** An array's component type has no source position of its own; its name is read from the array reference. */
    @Test
    void anArrayOfAProjectTypeIsNamedByItsComponentAndCallsOnItResolve() throws Exception {
        Map<String, String> sources = Map.of(
                "demo/Holder.java", "package demo; public class Holder { Item[] items;"
                        + " void take(Item[] a) { a[0].run(); } }",
                "demo/Item.java", "package demo; public class Item { public void run() {} }");

        DumpRun run = DumpRun.of(dir, sources);

        assertEquals("demo.Item[]", DumpRun.one(run.rows("members"), "name", "items").path("typeFqn").asText());
        JsonNode call = DumpRun.one(run.rows("calls"), "name", "run");
        assertEquals("demo.Item", call.path("recv").path("typeFqn").asText());
        assertEquals("demo.Item#run()", call.path("targets").get(0).path("id").asText());
    }

    /**
     * Noclasspath mode reports a compile error without throwing (ModelBuildingException is for a full classpath). A
     * syntax error and a type error each leave a file counted, and the rest of the checkout is dumped.
     */
    @Test
    void aNonCompilingSourceDoesNotThrowAndTheCheckoutIsStillDumped() throws Exception {
        DumpRun run = DumpRun.of(dir, Map.of(
                "demo/Broken.java", "package demo; public class Broken { void f( { }",
                "demo/Typed.java", "package demo; public class Typed { final int x = 1;"
                        + " void g() { x = 2; int y = \"s\"; } }",
                "demo/Good.java", "package demo; public class Good { void h() { new Typed(); } }"));

        JsonNode meta = run.meta();
        assertEquals(1, meta.path("counts").path("failedFiles").asInt(), meta.toString());
        assertTrue(run.rows("types").size() >= 3, "the rest of the checkout is still dumped");
        DumpRun.one(run.rows("calls"), "name", "<init>");
    }
}

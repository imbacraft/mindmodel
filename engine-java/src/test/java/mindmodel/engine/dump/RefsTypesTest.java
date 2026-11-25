package mindmodel.engine.dump;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;

import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;
import java.util.Map;

import com.fasterxml.jackson.databind.JsonNode;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

/** types.ndjson supertypes, members.ndjson field and parameter types, calls.ndjson receiver type arguments. */
class RefsTypesTest {

    @TempDir
    Path dir;

    private static final String REPO = """
            package demo;
            import java.util.List;
            import java.util.Map;
            public class Repo extends Base<Order> implements Store<Order, String> {
                private Map<String, List<Order>> byKey;
                List<Order> find(Map<String, Order> index, List<Order> extra) {
                    return extra.subList(0, extra.size());
                }
            }
            """;

    private static final Map<String, String> SOURCES = Map.of(
            "demo/Repo.java", REPO,
            "demo/Base.java", "package demo; public abstract class Base<T> {}",
            "demo/Store.java", "package demo; public interface Store<T, K> {}",
            "demo/Order.java", "package demo; public class Order {}");

    @Test
    void supertypesKeepTheirWrittenTypeArguments() throws Exception {
        JsonNode repo = DumpRun.one(DumpRun.of(dir, SOURCES).rows("types"), "fqn", "demo.Repo");

        JsonNode base = repo.path("supertypes").get(0);
        assertEquals("class", base.path("kind").asText());
        assertEquals("demo.Base", base.path("fqn").asText());
        assertEquals("Base<Order>", base.path("text").asText());

        JsonNode store = repo.path("supertypes").get(1);
        assertEquals("interface", store.path("kind").asText());
        assertEquals("demo.Store", store.path("fqn").asText());
        assertEquals("Store<Order, String>", store.path("text").asText());
    }

    @Test
    void fieldTypeKeepsItsNestedGenericArguments() throws Exception {
        JsonNode field = DumpRun.one(DumpRun.of(dir, SOURCES).rows("members"), "name", "byKey");

        assertEquals("Map<String, List<Order>>", field.path("type").asText());
        assertEquals("java.util.Map", field.path("typeFqn").asText());
    }

    @Test
    void parameterTypesKeepTheirGenericArgumentsAndTheMethodIdSpellsThemTheSameWay() throws Exception {
        JsonNode find = DumpRun.one(DumpRun.of(dir, SOURCES).rows("members"), "name", "find");

        assertEquals("Map<String, Order>", find.path("params").get(0).path("type").asText());
        assertEquals("List<Order>", find.path("params").get(1).path("type").asText());
        assertEquals("List<Order>", find.path("returns").asText());
        assertEquals("demo.Repo#find(Map<String, Order>,List<Order>)", find.path("id").asText());
    }

    /** Wildcards are spelled as Java writes them, in every type text and in a receiver's type arguments. */
    @Test
    void wildcardsKeepTheirSpaceInParamsMethodIdsAndTypeArguments() throws Exception {
        Map<String, String> wild = Map.of(
                "demo/Wild.java", """
                        package demo;
                        import java.util.List;
                        import java.util.Map;
                        public class Wild {
                            private List<? extends Order> fed;
                            void take(List<? extends Order> xs, Map<? super Order, ?> m) {
                                fed.size();
                                xs.isEmpty();
                            }
                        }
                        """,
                "demo/Order.java", "package demo; public class Order {}");
        DumpRun run = DumpRun.of(dir, wild);

        JsonNode take = DumpRun.one(run.rows("members"), "name", "take");
        assertEquals("List<? extends Order>", take.path("params").get(0).path("type").asText());
        assertEquals("Map<? super Order, ?>", take.path("params").get(1).path("type").asText());
        assertEquals("demo.Wild#take(List<? extends Order>,Map<? super Order, ?>)", take.path("id").asText());
        assertEquals("List<? extends Order>",
                DumpRun.one(run.rows("members"), "name", "fed").path("type").asText());
        assertEquals("? extends demo.Order",
                DumpRun.one(run.rows("calls"), "name", "isEmpty").path("recv").path("typeArgs").get(0).asText());
        assertFalse(Files.readString(run.out.resolve("members.ndjson")).contains("?extends"));
    }

    @Test
    void receiverParameterCarriesItsTypeArgumentsIntoTheCall() throws Exception {
        JsonNode size = DumpRun.one(DumpRun.of(dir, SOURCES).rows("calls"), "name", "size");

        assertEquals("java.util.List", size.path("recv").path("type").asText());
        assertEquals("demo.Order", size.path("recv").path("typeArgs").get(0).asText());
    }
}

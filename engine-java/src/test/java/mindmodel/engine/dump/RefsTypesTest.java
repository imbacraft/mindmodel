package mindmodel.engine.dump;

import static org.junit.jupiter.api.Assertions.assertEquals;

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
        assertEquals("Store<Order,String>", store.path("text").asText());
    }

    @Test
    void fieldTypeKeepsItsNestedGenericArguments() throws Exception {
        JsonNode field = DumpRun.one(DumpRun.of(dir, SOURCES).rows("members"), "name", "byKey");

        assertEquals("Map<String,List<Order>>", field.path("type").asText());
        assertEquals("java.util.Map", field.path("typeFqn").asText());
    }

    @Test
    void parameterTypesKeepTheirGenericArgumentsAndTheMethodIdSpellsThemTheSameWay() throws Exception {
        JsonNode find = DumpRun.one(DumpRun.of(dir, SOURCES).rows("members"), "name", "find");

        assertEquals("Map<String,Order>", find.path("params").get(0).path("type").asText());
        assertEquals("List<Order>", find.path("params").get(1).path("type").asText());
        assertEquals("List<Order>", find.path("returns").asText());
        assertEquals("demo.Repo#find(Map<String,Order>,List<Order>)", find.path("id").asText());
    }

    @Test
    void receiverParameterCarriesItsTypeArgumentsIntoTheCall() throws Exception {
        JsonNode size = DumpRun.one(DumpRun.of(dir, SOURCES).rows("calls"), "name", "size");

        assertEquals("java.util.List", size.path("recv").path("type").asText());
        assertEquals("demo.Order", size.path("recv").path("typeArgs").get(0).asText());
    }
}

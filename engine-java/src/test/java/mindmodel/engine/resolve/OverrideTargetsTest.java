package mindmodel.engine.resolve;

import static org.junit.jupiter.api.Assertions.assertEquals;

import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;

import com.fasterxml.jackson.databind.JsonNode;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import mindmodel.engine.run.DumpRun;

/** A call's targets: the declaration, then the overrides that the receiver's type can reach, and no others. */
class OverrideTargetsTest {

    @TempDir
    Path dir;

    private static final Map<String, String> SOURCES = Map.of(
            "demo/Base.java",
            "package demo; public abstract class Base { public String getSettings() { return \"\"; } }",
            "demo/BaseItems.java", "package demo; public class BaseItems extends Base {"
                    + " @Override public String getSettings() { return \"items\"; } }",
            "demo/Hero.java", "package demo; public class Hero extends Base { }",
            "demo/HeroSub.java", "package demo; public class HeroSub extends Hero {"
                    + " @Override public String getSettings() { return \"sub\"; } }",
            "demo/Use.java", """
                    package demo;
                    public class Use {
                        String onHero(Hero hero) { return hero.getSettings(); }
                        String onBase(Base base) { return base.getSettings(); }
                    }
                    """);

    /** The ids of a call's targets, in the order the dump writes them. */
    private static List<String> targetIds(JsonNode call) {
        List<String> ids = new ArrayList<>();
        for (JsonNode target : call.path("targets")) ids.add(target.path("id").asText());
        return ids;
    }

    /** The row of the {@code getSettings} call on the line that contains {@code needle}. */
    private static JsonNode getSettingsOn(List<JsonNode> calls, String needle) {
        int line = DumpRun.lineOf(SOURCES.get("demo/Use.java"), needle);
        return calls.stream()
                .filter(r -> r.path("line").asInt() == line && "getSettings".equals(r.path("name").asText()))
                .findFirst().orElseThrow(() -> new AssertionError("no getSettings call for " + needle));
    }

    /**
     * {@code BaseItems} overrides {@code getSettings} in a sibling branch of {@code Hero}: a call on a {@code Hero}
     * must not list it. The override {@code HeroSub} writes is a subtype of {@code Hero}, so it stays.
     */
    @Test
    void aSiblingBranchOverrideIsNoTargetOfACallOnTheReceiversType() throws Exception {
        JsonNode call = getSettingsOn(DumpRun.of(dir, SOURCES).rows("calls"), "onHero");
        assertEquals(List.of("demo.Base#getSettings()", "demo.HeroSub#getSettings()"), targetIds(call));
    }

    /** A call on the base type still reaches every override of it, sibling branches included. */
    @Test
    void aCallOnTheDeclaringTypeReachesEveryOverride() throws Exception {
        JsonNode call = getSettingsOn(DumpRun.of(dir, SOURCES).rows("calls"), "onBase");
        assertEquals(List.of("demo.Base#getSettings()", "demo.BaseItems#getSettings()",
                "demo.HeroSub#getSettings()"), targetIds(call));
    }
}

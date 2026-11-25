package mindmodel.engine.dump;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotEquals;

import java.nio.file.Path;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.stream.Collectors;

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

    /** The ids of the members a source's annotations generated (`generatedBy` set), as the dump writes them. */
    private static Set<String> generated(Path dir, String file, String source) throws Exception {
        return DumpRun.of(dir, Map.of(file, source)).rows("members").stream()
                .filter(m -> !m.path("generatedBy").isMissingNode() && !m.path("generatedBy").isNull())
                .map(m -> m.path("id").asText()).collect(Collectors.toSet());
    }

    @Test
    void booleanFieldWithAnIsPrefixIsItsOwnGetterName() throws Exception {
        String flags = """
                package demo;
                import lombok.Getter;
                import lombok.Setter;
                @Getter @Setter public class Flags { boolean isActive; }
                """;
        String boxed = """
                package demo;
                import lombok.Getter;
                @Getter public class Boxed { Boolean active; }
                """;

        Set<String> ids = generated(dir, "demo/Flags.java", flags);
        assertEquals(true, ids.contains("demo.Flags#isActive()"), ids.toString());
        assertEquals(true, ids.contains("demo.Flags#setActive(boolean)"), ids.toString());
        assertEquals(false, ids.contains("demo.Flags#isIsActive()"), ids.toString());

        Set<String> boxedIds = generated(dir, "demo/Boxed.java", boxed);
        assertEquals(true, boxedIds.contains("demo.Boxed#getActive()"), boxedIds.toString());
        assertEquals(false, boxedIds.contains("demo.Boxed#isActive()"), boxedIds.toString());
    }

    @Test
    void loggerFieldIsLogWithTheTypeItsAnnotationNames() throws Exception {
        Map<String, String> loggers = new java.util.LinkedHashMap<>();
        loggers.put("lombok.extern.slf4j.Slf4j", "org.slf4j.Logger");
        loggers.put("lombok.extern.log4j.Log4j2", "org.apache.logging.log4j.Logger");
        loggers.put("lombok.extern.apachecommons.CommonsLog", "org.apache.commons.logging.Log");
        loggers.put("lombok.extern.jbosslog.JBossLog", "org.jboss.logging.Logger");
        loggers.put("lombok.extern.slf4j.XSlf4j", "org.slf4j.ext.XLogger");
        loggers.put("lombok.extern.java.Log", "java.util.logging.Logger");
        for (var entry : loggers.entrySet()) {
            String annotation = entry.getKey().substring(entry.getKey().lastIndexOf('.') + 1);
            String source = "package demo;\nimport " + entry.getKey() + ";\n@" + annotation
                    + " public class Logged { void f() { log.info(\"x\"); } }\n";
            JsonNode info = DumpRun.one(DumpRun.of(dir, Map.of("demo/Logged.java", source)).rows("calls"),
                    "name", "info");

            assertEquals(entry.getValue(), info.path("recv").path("typeFqn").asText(), annotation);
        }
    }

    /** The compiler writes an enum's values() and valueOf(String): their origin says so, not lombok. */
    @Test
    void enumValuesAndValueOfAreCompilerGenerated() throws Exception {
        Map<String, String> sources = Map.of(
                "demo/Color.java", "package demo; public enum Color { RED }",
                "demo/Use.java", "package demo; public class Use { Object f() {"
                        + " return Color.values().length + Color.valueOf(\"RED\").ordinal(); } }");
        DumpRun run = DumpRun.of(dir, sources);

        for (String name : List.of("values", "valueOf")) {
            JsonNode call = DumpRun.one(run.rows("calls"), "name", name);
            assertEquals("compiler", call.path("origin").asText(), name);
            assertEquals("demo.Color#" + name + (name.equals("valueOf") ? "(String)" : "()"),
                    call.path("targets").get(0).path("id").asText(), name);
        }
        JsonNode member = DumpRun.one(run.rows("members"), "name", "values");
        assertEquals("compiler", member.path("generated").asText());
    }

    @Test
    void enumNameAndOrdinalAreInheritedNotGenerated() throws Exception {
        Map<String, String> sources = Map.of(
                "demo/Color.java", "package demo; public enum Color { RED }",
                "demo/Use.java", "package demo; public class Use { String f(Color c) {"
                        + " return c.name() + c.ordinal(); } }");
        List<JsonNode> calls = DumpRun.of(dir, sources).rows("calls");

        for (String name : List.of("name", "ordinal")) {
            JsonNode call = DumpRun.one(calls, "name", name);
            assertEquals(List.of(), call.path("targets").findValuesAsText("id"), name + " is java.lang.Enum's");
            // Without a classpath Spoon has no declaration for Enum.name(), so the origin is unresolved, not lombok.
            assertNotEquals("lombok", call.path("origin").asText(), name);
        }
    }

    @Test
    void constructorsFollowLombokRequiredAndExplicitRules() throws Exception {
        String required = """
                package demo;
                import lombok.RequiredArgsConstructor;
                @RequiredArgsConstructor public class Req {
                    private final String fixed = "a";
                    private final int must;
                    static final int S = 1;
                }
                """;
        String plain = """
                package demo;
                import lombok.Data;
                @Data public class Plain { int x; }
                """;
        String explicit = """
                package demo;
                import lombok.AllArgsConstructor;
                @AllArgsConstructor public class Explicit {
                    int x;
                    public Explicit(int x) { this.x = x; }
                }
                """;

        assertEquals(Set.of("demo.Req#Req(int)"), constructorsOf(dir, "demo/Req.java", required, "demo.Req"));
        assertEquals(Set.of("demo.Plain#Plain()"), constructorsOf(dir, "demo/Plain.java", plain, "demo.Plain"));
        assertEquals(Set.of(), constructorsOf(dir, "demo/Explicit.java", explicit, "demo.Explicit"),
                "an explicit constructor with the same signature suppresses the generated one");
    }

    private static Set<String> constructorsOf(Path dir, String file, String source, String owner) throws Exception {
        return generated(dir, file, source).stream().filter(id -> id.startsWith(owner + "#" + owner.substring(
                owner.lastIndexOf('.') + 1) + "(")).collect(Collectors.toSet());
    }

    @Test
    void getterWithAccessLevelNoneIsNotGenerated() throws Exception {
        String source = """
                package demo;
                import lombok.AccessLevel;
                import lombok.Getter;
                @Getter public class Hidden {
                    @Getter(AccessLevel.NONE) int secret;
                    int open;
                }
                """;

        Set<String> ids = generated(dir, "demo/Hidden.java", source);
        assertEquals(true, ids.contains("demo.Hidden#getOpen()"), ids.toString());
        assertEquals(false, ids.contains("demo.Hidden#getSecret()"), ids.toString());
    }
}

package mindmodel.engine.resolve;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.junit.jupiter.api.Assumptions.assumeTrue;

import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.TreeMap;
import java.util.TreeSet;

import com.fasterxml.jackson.databind.JsonNode;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import mindmodel.engine.model.SourceModel;
import mindmodel.engine.run.DumpRun;
import mindmodel.engine.run.LombokJar;

/**
 * The delombok oracle against the hand-written Lombok rules. Each case dumps the same sources both ways. The members
 * Lombok generated must be the same, except for the differences the case lists, and each listed difference is a place
 * the hand-written rules were wrong (delombok is Lombok's own answer). Skipped without a Lombok jar.
 */
class LombokOracleTest {

    @TempDir
    Path dir;

    private Path jar;

    @BeforeEach
    void findTheJar() {
        jar = LombokJar.find();
        assumeTrue(jar != null, "no Lombok jar: set MINDMODEL_LOMBOK_JAR, or put lombok in ~/.m2, to run the oracle");
    }

    /** A source file's text, one line per argument. */
    private static String src(String... lines) {
        return String.join("\n", lines) + "\n";
    }

    /** A generated member's identity (its id, or owner#name for a field) and how it was written. */
    private static Map<String, String> generated(DumpRun run) throws Exception {
        Map<String, String> out = new TreeMap<>();
        for (JsonNode m : run.rows("members")) {
            if (m.path("generatedBy").isNull() || m.path("generatedBy").isMissingNode()) continue;
            boolean field = "field".equals(m.path("kind").asText());
            String key = field ? m.path("owner").asText() + "#" + m.path("name").asText() : m.path("id").asText();
            out.put(key, m.path("generatedBy").asText() + " returns=" + m.path("returns").asText()
                    + " type=" + m.path("type").asText() + " pos=" + m.path("pos").toString());
        }
        return out;
    }

    /** The members the two answers disagree on: added by delombok, dropped by the hand rules, or written otherwise. */
    private record Diff(Set<String> added, Set<String> removed, Set<String> changed) {
    }

    private static Diff diff(Map<String, String> hand, Map<String, String> oracle) {
        Set<String> added = new TreeSet<>(), removed = new TreeSet<>(), changed = new TreeSet<>();
        for (String key : oracle.keySet()) if (!hand.containsKey(key)) added.add(key);
        for (String key : hand.keySet()) if (!oracle.containsKey(key)) removed.add(key);
        for (String key : oracle.keySet())
            if (hand.containsKey(key) && !hand.get(key).equals(oracle.get(key))) changed.add(key);
        return new Diff(added, removed, changed);
    }

    /** Both answers for one set of sources: the hand rules (no jar), then delombok with the jar. */
    private record Both(DumpRun hand, DumpRun oracle, Map<String, String> handMembers,
            Map<String, String> oracleMembers) {
    }

    private Both both(String name, Map<String, String> sources) throws Exception {
        List<String> listed = new ArrayList<>();
        for (String key : sources.keySet()) if (key.endsWith(".java")) listed.add(key);
        DumpRun hand = DumpRun.of(dir.resolve(name + "-hand"), sources, listed);
        DumpRun oracle = DumpRun.of(dir.resolve(name + "-oracle"), sources, listed, SourceModel.compliance(),
                List.of(), List.of(), jar);
        assertEquals("delombok", oracle.meta().path("lombok").path("mode").asText(), oracle.meta().toString());
        return new Both(hand, oracle, generated(hand), generated(oracle));
    }

    private static void assertDiff(Both both, Set<String> added, Set<String> removed, Set<String> changed) {
        Diff d = diff(both.handMembers(), both.oracleMembers());
        assertEquals(added, d.added(), "added by delombok; the oracle has " + both.oracleMembers());
        assertEquals(removed, d.removed(), "missing from the hand rules' answer");
        assertEquals(changed, d.changed(), "written differently by the hand rules");
    }

    private static JsonNode call(DumpRun run, String name) throws Exception {
        return DumpRun.one(run.rows("calls"), "name", name);
    }

    private static Set<String> ids(Map<String, String> members, String... fragments) {
        Set<String> out = new TreeSet<>();
        for (String key : members.keySet())
            for (String fragment : fragments)
                if (key.contains(fragment)) out.add(key);
        return out;
    }

    // The cases LombokTest covers, each as both answers.

    @Test
    void toStringIsTheSameMemberAndIsGeneratedByToString() throws Exception {
        Both b = both("tostring", Map.of("demo/Tagged.java",
                src("package demo;", "import lombok.ToString;", "@ToString", "public class Tagged { int x; }")));

        assertDiff(b, Set.of(), Set.of(), Set.of());
        assertTrue(b.oracleMembers().get("demo.Tagged#toString()").startsWith("ToString "),
                b.oracleMembers().toString());
    }

    @Test
    void builderChainIsTypedTheSameWayAndDelombokAddsTheMembersTheHandRulesMissed() throws Exception {
        Both b = both("builder", Map.of(
                "demo/EmailSendResult.java", src("package demo;", "import lombok.Builder;", "@Builder",
                        "public class EmailSendResult { String provider; }"),
                "demo/Use.java", src("package demo;", "public class Use {",
                        "    Object send() { return EmailSendResult.builder().provider(null).build(); }", "}")));

        JsonNode provider = call(b.oracle(), "provider");
        assertEquals("demo.EmailSendResult.EmailSendResultBuilder", provider.path("recv").path("typeFqn").asText());
        assertEquals("demo.EmailSendResult.EmailSendResultBuilder#provider(String)",
                provider.path("targets").get(0).path("id").asText());
        assertEquals("lombok", provider.path("origin").asText());
        // @Builder writes an all-arguments constructor when the class has none, and a builder constructor, its
        // toString and its field too: the hand rules write none of them. Its build() returns the class as written.
        assertDiff(b, Set.of("demo.EmailSendResult#EmailSendResult(String)",
                        "demo.EmailSendResult.EmailSendResultBuilder#EmailSendResultBuilder()",
                        "demo.EmailSendResult.EmailSendResultBuilder#toString()",
                        "demo.EmailSendResult.EmailSendResultBuilder#provider"),
                Set.of(), Set.of("demo.EmailSendResult.EmailSendResultBuilder#build()"));
    }

    @Test
    void booleanFieldWithAnIsPrefixIsTheSameMember() throws Exception {
        Both b = both("flags", Map.of(
                "demo/Flags.java", src("package demo;", "import lombok.Getter;", "import lombok.Setter;",
                        "@Getter @Setter public class Flags { boolean isActive; }"),
                "demo/Boxed.java", src("package demo;", "import lombok.Getter;",
                        "@Getter public class Boxed { Boolean active; }")));

        assertDiff(b, Set.of(), Set.of(), Set.of());
        assertTrue(b.oracleMembers().containsKey("demo.Flags#isActive()"), b.oracleMembers().toString());
        assertTrue(b.oracleMembers().containsKey("demo.Flags#setActive(boolean)"), b.oracleMembers().toString());
        assertTrue(b.oracleMembers().containsKey("demo.Boxed#getActive()"), b.oracleMembers().toString());
    }

    @Test
    void loggerFieldTakesTheTypeItsAnnotationNames() throws Exception {
        Map<String, String> loggers = new TreeMap<>();
        loggers.put("lombok.extern.slf4j.Slf4j", "org.slf4j.Logger");
        loggers.put("lombok.extern.log4j.Log4j2", "org.apache.logging.log4j.Logger");
        loggers.put("lombok.extern.apachecommons.CommonsLog", "org.apache.commons.logging.Log");
        loggers.put("lombok.extern.jbosslog.JBossLog", "org.jboss.logging.Logger");
        loggers.put("lombok.extern.slf4j.XSlf4j", "org.slf4j.ext.XLogger");
        loggers.put("lombok.extern.java.Log", "java.util.logging.Logger");
        for (var entry : loggers.entrySet()) {
            String annotation = entry.getKey().substring(entry.getKey().lastIndexOf('.') + 1);
            Both b = both("logger-" + annotation, Map.of("demo/Logged.java", src("package demo;",
                    "import " + entry.getKey() + ";", "@" + annotation + " public class Logged {",
                    "    void f() { log.info(\"x\"); } }")));

            assertEquals(entry.getValue(), call(b.oracle(), "info").path("recv").path("typeFqn").asText(), annotation);
            assertDiff(b, Set.of(), Set.of(), Set.of());
        }
    }

    @Test
    void constructorsFollowLombokRequiredAndExplicitRules() throws Exception {
        Both b = both("ctors", Map.of(
                "demo/Req.java", src("package demo;", "import lombok.RequiredArgsConstructor;",
                        "@RequiredArgsConstructor public class Req {",
                        "    private final String fixed = \"a\";", "    private final int must;",
                        "    static final int S = 1;", "}"),
                "demo/Plain.java", src("package demo;", "import lombok.Data;", "@Data public class Plain { int x; }"),
                "demo/Explicit.java", src("package demo;", "import lombok.AllArgsConstructor;",
                        "@AllArgsConstructor public class Explicit {", "    int x;",
                        "    public Explicit(int x) { this.x = x; }", "}")));

        assertEquals(Set.of("demo.Req#Req(int)", "demo.Plain#Plain()"), ids(b.oracleMembers(), "Req(", "Plain()"));
        assertEquals(Set.of(), ids(b.oracleMembers(), "Explicit("),
                "an explicit constructor suppresses the generated one");
        // @Data writes canEqual, which the hand rules leave out; the accessors are labelled Data, not the accessor.
        assertDiff(b, Set.of("demo.Plain#canEqual(Object)"), Set.of(),
                Set.of("demo.Plain#equals(Object)", "demo.Plain#getX()", "demo.Plain#hashCode()",
                        "demo.Plain#setX(int)", "demo.Plain#toString()"));
    }

    @Test
    void getterWithAccessLevelNoneIsNotGeneratedInEitherAnswer() throws Exception {
        Both b = both("none", Map.of("demo/Hidden.java", src("package demo;", "import lombok.AccessLevel;",
                "import lombok.Getter;", "@Getter public class Hidden {",
                "    @Getter(AccessLevel.NONE) int secret;", "    int open;", "}")));

        assertEquals(Set.of("demo.Hidden#getOpen()"), b.oracleMembers().keySet());
        assertDiff(b, Set.of(), Set.of(), Set.of());
    }

    @Test
    void aLombokConstructorIsWrittenOnceAndPlacedAtTheClass() throws Exception {
        Both b = both("order", Map.of("demo/Order.java",
                src("package demo;", "import lombok.Data;", "@Data", "public class Order { private int id; }")));

        List<JsonNode> ctors = new ArrayList<>();
        for (JsonNode m : b.oracle().rows("members"))
            if ("demo.Order#Order()".equals(m.path("id").asText())) ctors.add(m);
        assertEquals(1, ctors.size(), ctors.toString());
        assertEquals("lombok", ctors.get(0).path("generated").asText());
        assertFalse(ctors.get(0).path("pos").isNull(), "Lombok's constructor is placed at the class");
    }

    // The cases the hand rules do not cover: each one is a difference the oracle answers.

    @Test
    void fluentAccessorsFromAnAnnotationAreNamedAsTheFieldIs() throws Exception {
        Both b = both("fluent", Map.of("demo/Fluent.java", src("package demo;", "import lombok.Getter;",
                "import lombok.Setter;", "import lombok.experimental.Accessors;",
                "@Getter @Setter @Accessors(fluent = true)", "public class Fluent { private String name; }")));

        assertEquals(Set.of("demo.Fluent#name()", "demo.Fluent#name(String)"), b.oracleMembers().keySet());
        assertDiff(b, Set.of("demo.Fluent#name()", "demo.Fluent#name(String)"),
                Set.of("demo.Fluent#getName()", "demo.Fluent#setName(String)"), Set.of());
    }

    @Test
    void lombokConfigIsReadFromTheCheckoutFolderAndItsSubfolders() throws Exception {
        Both b = both("config", Map.of(
                "lombok.config", "lombok.accessors.fluent = true\n",
                "demo/Fluent.java", src("package demo;", "import lombok.Getter;",
                        "@Getter public class Fluent { private String name; }"),
                "sub/lombok.config", "lombok.accessors.fluent = false\n",
                "sub/Named.java", src("package sub;", "import lombok.Getter;",
                        "@Getter public class Named { private String name; }")));

        assertTrue(b.oracleMembers().containsKey("demo.Fluent#name()"), b.oracleMembers().toString());
        assertTrue(b.oracleMembers().containsKey("sub.Named#getName()"), b.oracleMembers().toString());
        assertTrue(b.handMembers().containsKey("demo.Fluent#getName()"), "the hand rules ignore lombok.config");
    }

    @Test
    void superBuilderIsItsWholeBuilderHierarchy() throws Exception {
        Both b = both("superbuilder", Map.of("sub/Base.java", src("package sub;",
                "import lombok.experimental.SuperBuilder;", "@SuperBuilder public class Base { private String a; }")));

        assertTrue(b.oracleMembers().containsKey("sub.Base.BaseBuilderImpl#self()"), b.oracleMembers().toString());
        assertTrue(b.oracleMembers().containsKey("sub.Base#Base(Base.BaseBuilder<?, ?>)"),
                b.oracleMembers().toString());
        assertDiff(b, Set.of("sub.Base#Base(Base.BaseBuilder<?, ?>)", "sub.Base.BaseBuilder#self()",
                        "sub.Base.BaseBuilder#toString()", "sub.Base.BaseBuilder#a",
                        "sub.Base.BaseBuilderImpl#BaseBuilderImpl()", "sub.Base.BaseBuilderImpl#build()",
                        "sub.Base.BaseBuilderImpl#self()"),
                Set.of(), Set.of("sub.Base.BaseBuilder#a(String)", "sub.Base.BaseBuilder#build()"));
    }

    @Test
    void singularBuilderMethodsTakeTheCollectionTheyAreWrittenWith() throws Exception {
        Both b = both("singular", Map.of("demo/Bag.java", src("package demo;", "import lombok.Builder;",
                "import lombok.Singular;", "@Builder public class Bag { @Singular java.util.List<String> tags; }")));

        assertTrue(b.oracleMembers().containsKey("demo.Bag.BagBuilder#tags(java.util.Collection<? extends String>)"),
                b.oracleMembers().toString());
        assertTrue(b.oracleMembers().containsKey("demo.Bag.BagBuilder#tag(String)"), b.oracleMembers().toString());
        assertTrue(b.oracleMembers().containsKey("demo.Bag.BagBuilder#clearTags()"), b.oracleMembers().toString());
        assertTrue(b.handMembers().containsKey("demo.Bag.BagBuilder#tags(java.util.List<String>)"));
        assertDiff(b, Set.of("demo.Bag#Bag(java.util.List<String>)", "demo.Bag.BagBuilder#BagBuilder()",
                        "demo.Bag.BagBuilder#clearTags()", "demo.Bag.BagBuilder#tag(String)",
                        "demo.Bag.BagBuilder#tags", "demo.Bag.BagBuilder#tags(java.util.Collection<? extends String>)",
                        "demo.Bag.BagBuilder#toString()"),
                Set.of("demo.Bag.BagBuilder#tags(java.util.List<String>)"), Set.of("demo.Bag.BagBuilder#build()"));
    }

    @Test
    void witherIsAMemberTheHandRulesDoNotWrite() throws Exception {
        Both b = both("with", Map.of("demo/Point.java", src("package demo;", "import lombok.With;",
                "import lombok.AllArgsConstructor;", "@AllArgsConstructor public class Point { @With int x; }")));

        assertDiff(b, Set.of("demo.Point#withX(int)"), Set.of(), Set.of());
        assertTrue(b.oracleMembers().get("demo.Point#withX(int)").startsWith("With returns=Point "),
                b.oracleMembers().toString());
    }

    // Degradation: an answer that is not delombok's says why, and the hand rules still write the members.

    @Test
    void withoutAJarTheHandRulesAnswerAndMetaSaysWhy() throws Exception {
        Map<String, String> sources = Map.of("demo/Tagged.java",
                src("package demo;", "import lombok.ToString;", "@ToString", "public class Tagged { int x; }"));
        DumpRun run = DumpRun.of(dir.resolve("nojar"), sources, List.of("demo/Tagged.java"));

        JsonNode lombok = run.meta().path("lombok");
        assertEquals("hand", lombok.path("mode").asText());
        assertEquals(1, lombok.path("files").asInt());
        assertTrue(lombok.path("reason").asText().startsWith("no --lombok jar"), lombok.toString());
        assertEquals("ToString", generated(run).get("demo.Tagged#toString()").split(" ")[0]);
    }

    @Test
    void aMissingJarIsAHandAnswerWithItsReasonAndNoPath() throws Exception {
        Map<String, String> sources = Map.of("demo/Tagged.java",
                src("package demo;", "import lombok.ToString;", "@ToString", "public class Tagged { int x; }"));
        DumpRun run = DumpRun.of(dir.resolve("missing"), sources, List.of("demo/Tagged.java"),
                SourceModel.compliance(), List.of(), List.of(), dir.resolve("no-such-lombok.jar"));

        JsonNode lombok = run.meta().path("lombok");
        assertEquals("hand", lombok.path("mode").asText());
        assertEquals("the lombok jar is not a readable file", lombok.path("reason").asText());
        assertEquals("ToString", generated(run).get("demo.Tagged#toString()").split(" ")[0]);
    }

    @Test
    void aJarDelombokCannotRunIsAHandAnswerWithDelomboksReason() throws Exception {
        Path corrupt = dir.resolve("corrupt-lombok.jar");
        Files.writeString(corrupt, "this is not a jar");
        Map<String, String> sources = Map.of("demo/Tagged.java",
                src("package demo;", "import lombok.ToString;", "@ToString", "public class Tagged { int x; }"));
        DumpRun run = DumpRun.of(dir.resolve("corrupt"), sources, List.of("demo/Tagged.java"),
                SourceModel.compliance(), List.of(), List.of(), corrupt);

        JsonNode lombok = run.meta().path("lombok");
        assertEquals("hand", lombok.path("mode").asText());
        assertTrue(lombok.path("reason").asText().startsWith("delombok exited "), lombok.toString());
        assertFalse(lombok.path("reason").asText().contains(dir.toString()), "a reason names no path");
        assertEquals(1, generated(run).size(), "the hand rules still write the member");
    }

    @Test
    void theOracleAnswerIsTheSameAtAnyLocation() throws Exception {
        Map<String, String> sources = Map.of("demo/Order.java",
                src("package demo;", "import lombok.Data;", "@Data public class Order { private int id; }"));
        DumpRun here = DumpRun.of(dir.resolve("one/two"), sources, List.of("demo/Order.java"),
                SourceModel.compliance(), List.of(), List.of(), jar);
        DumpRun there = DumpRun.of(dir.resolve("three"), sources, List.of("demo/Order.java"),
                SourceModel.compliance(), List.of(), List.of(), jar);

        for (String file : List.of("members.ndjson", "calls.ndjson", "types.ndjson", "meta.json"))
            assertEquals(Files.readString(here.out.resolve(file)), Files.readString(there.out.resolve(file)), file);
    }
}

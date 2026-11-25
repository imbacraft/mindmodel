package mindmodel.engine.write;

import static org.junit.jupiter.api.Assertions.assertEquals;

import java.nio.file.Path;
import java.util.List;
import java.util.Map;

import com.fasterxml.jackson.databind.JsonNode;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import mindmodel.engine.run.DumpRun;

/** members.ndjson `returned`: the value each arm of a switch expression produces. */
class ReturnsTest {

    @TempDir
    Path dir;

    /** A nested switch expression inside an arm: its yields belong to it, not to the arm that holds it. */
    @Test
    void armValueIsTheArmsOwnYieldNotANestedSwitchsYield() throws Exception {
        String source = """
                package demo;
                public class Pick {
                    static int pick(int a, int b) {
                        return switch (a) {
                            case 1 -> {
                                int x = switch (b) {
                                    case 2 -> { yield 10; }
                                    default -> { yield 11; }
                                };
                                yield 7;
                            }
                            default -> 0;
                        };
                    }
                }
                """;
        JsonNode pick = DumpRun.one(DumpRun.of(dir, Map.of("demo/Pick.java", source)).rows("members"),
                "name", "pick");

        JsonNode outer = null;
        for (JsonNode entry : pick.path("returned"))
            if (entry.path("target").isMissingNode() && "expression".equals(entry.path("form").asText())) outer = entry;
        if (outer == null) throw new AssertionError("no outer switch expression in " + pick.path("returned"));
        JsonNode arm = outer.path("arms").get(0);
        assertEquals("1", arm.path("labels").get(0).asText());
        assertEquals("7", arm.path("value").path("text").asText(), "the outer arm yields 7, not the nested 10");
        assertEquals("0", outer.path("arms").get(1).path("value").path("value").path("value").asText());
    }

    /** The same trap with a `return` switch whose arm yields a local the nested switch's arms also name. */
    @Test
    void returnedSwitchArmYieldsItsLocalNotANestedArmsValue() throws Exception {
        String source = """
                package demo;
                public class Pick2 {
                    String f(int k, int j) {
                        return switch (k) {
                            case 1 -> {
                                String v = switch (j) { case 0 -> { yield "a"; } default -> { yield "b"; } };
                                yield v;
                            }
                            default -> "z";
                        };
                    }
                }
                """;
        JsonNode f = DumpRun.one(DumpRun.of(dir, Map.of("demo/Pick2.java", source)).rows("members"), "name", "f");

        JsonNode outer = f.path("returned").get(0);
        assertEquals("v", outer.path("arms").get(0).path("value").path("text").asText());
        assertEquals("z", outer.path("arms").get(1).path("value").path("value").path("value").asText());
    }

    /** A statement switch that fills one local: an arm's value is its assignment, not a return from a nested switch. */
    @Test
    void statementArmValueIsItsAssignmentNotANestedReturn() throws Exception {
        String source = """
                package demo;
                public class Pick3 {
                    String g(int k, int j) {
                        String s;
                        switch (k) {
                            case 1:
                                switch (j) { case 0: return "a"; default: break; }
                                s = "b";
                                break;
                            default:
                                s = "z";
                        }
                        return s;
                    }
                }
                """;
        JsonNode g = DumpRun.one(DumpRun.of(dir, Map.of("demo/Pick3.java", source)).rows("members"), "name", "g");

        JsonNode chosen = null;
        for (JsonNode entry : g.path("returned"))
            if ("s".equals(entry.path("target").asText())) chosen = entry;
        if (chosen == null) throw new AssertionError("no switch that assigns s in " + g.path("returned"));
        assertEquals("\"b\"", chosen.path("arms").get(0).path("value").path("text").asText());
    }

    /** `case null, default` is a default arm that also takes null, and a `when` guard is written with its arm. */
    @Test
    void defaultWithNullAndGuardAreWritten() throws Exception {
        String source = """
                package demo;
                public class Sw {
                    String m(Object o) { return switch (o) { case null, default -> "d"; }; }
                    String g(Object o) {
                        return switch (o) { case String s when s.length() > 2 -> "long"; default -> "x"; };
                    }
                }
                """;
        var members = DumpRun.of(dir, Map.of("demo/Sw.java", source), List.of("demo/Sw.java"), 21).rows("members");
        JsonNode m = DumpRun.one(members, "name", "m").path("returned").get(0).path("arms").get(0);
        assertEquals(true, m.path("default").asBoolean(), "case null, default includes default");
        assertEquals("null", m.path("labels").get(0).asText());
        JsonNode g = DumpRun.one(members, "name", "g").path("returned").get(0).path("arms").get(0);
        assertEquals("s.length() > 2", g.path("guard").asText());
    }

    /** An arrow arm's value is its expression: the arm's own semicolon is not part of the text. */
    @Test
    void arrowArmTextHasNoSemicolon() throws Exception {
        String source = """
                package demo;
                public class Arm {
                    int h(int a) { return switch (a) { case 1 -> compute(); default -> 0; }; }
                    int compute() { return 1; }
                }
                """;
        var members = DumpRun.of(dir, Map.of("demo/Arm.java", source), List.of("demo/Arm.java"), 21).rows("members");
        JsonNode arms = DumpRun.one(members, "name", "h").path("returned").get(0).path("arms");
        assertEquals("compute()", arms.get(0).path("value").path("text").asText());
        assertEquals("0", arms.get(1).path("value").path("text").asText());
    }
}

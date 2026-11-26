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
 * A method reference is a call of the member it names, on its qualifier's type. Spoon types the reference only when it
 * can choose an overload; without the library's signature the reference is untyped, and the name alone decides when
 * the type declares that name once.
 */
class MethodRefTargetsTest {

    @TempDir
    Path dir;

    private static final Map<String, String> SOURCES = Map.of(
            "demo/Booking.java", "package demo; public class Booking { }",
            "demo/BookingSettings.java", "package demo; public class BookingSettings { }",
            "demo/Mapper.java", """
                    package demo;
                    public class Mapper {
                        public String toDto(Booking b) { return ""; }
                        public String single(Booking b) { return ""; }
                        public String toDto(BookingSettings s) { return ""; }
                    }
                    """,
            "demo/Use.java", """
                    package demo;
                    import org.example.Page;
                    public class Use {
                        private final Mapper mapper = new Mapper();
                        Object single(Page<Booking> bookings) { return bookings.map(mapper::single); }
                        Object overloaded(Page<Booking> bookings) { return bookings.map(mapper::toDto); }
                        Object unmatched(Page<String> names) { return names.map(mapper::toDto); }
                    }
                    """);

    /** The method-reference row of the name written on the line that contains {@code needle}. */
    private JsonNode refOn(String name, String needle) throws Exception {
        int line = DumpRun.lineOf(SOURCES.get("demo/Use.java"), needle);
        return DumpRun.of(dir, SOURCES).rows("calls").stream()
                .filter(r -> "methodRef".equals(r.path("kind").asText()) && r.path("line").asInt() == line
                        && name.equals(r.path("name").asText()))
                .findFirst().orElseThrow(() -> new AssertionError("no method reference " + name + " for " + needle));
    }

    /** A name the qualifier's type declares once is that method, though the library's signature is not known. */
    @Test
    void aMethodReferenceToAUniqueNameTargetsThatMember() throws Exception {
        JsonNode ref = refOn("single", "mapper::single");
        assertEquals(1, ref.path("targets").size());
        assertEquals("demo.Mapper#single(Booking)", ref.path("targets").get(0).path("id").asText());
        assertEquals("java", ref.path("origin").asText());
    }

    /** A Lombok getter named by a method reference: Spoon has no declaration for it, the synthesis does. */
    @Test
    void aMethodReferenceToALombokGetterTargetsTheGeneratedMember() throws Exception {
        Map<String, String> sources = Map.of(
                "demo/Booking.java", "package demo; import lombok.Getter; @Getter public class Booking { Long id; }",
                "demo/Use.java", """
                        package demo;
                        import java.util.List;
                        public class Use {
                            List<Long> ids(List<Booking> bookings) {
                                return bookings.stream().map(Booking::getId).toList();
                            }
                        }
                        """);
        var run = DumpRun.of(dir, sources);
        int line = DumpRun.lineOf(sources.get("demo/Use.java"), "Booking::getId");
        JsonNode ref = run.rows("calls").stream()
                .filter(r -> "methodRef".equals(r.path("kind").asText()) && r.path("line").asInt() == line)
                .findFirst().orElseThrow();
        assertEquals("demo.Booking#getId()", ref.path("targets").get(0).path("id").asText());
        assertEquals("lombok", ref.path("origin").asText());
    }

    /**
     * Two overloads of one name, passed to a call on a generic receiver: the overload that takes the receiver's one
     * type argument is the function's argument, so {@code Page<Booking>.map(mapper::toDto)} is {@code toDto(Booking)}.
     */
    @Test
    void anOverloadedMethodReferenceTakesTheOverloadOfTheReceiversTypeArgument() throws Exception {
        JsonNode ref = refOn("toDto", "bookings.map(mapper::toDto)");
        assertEquals(1, ref.path("targets").size());
        assertEquals("demo.Mapper#toDto(Booking)", ref.path("targets").get(0).path("id").asText());
        assertEquals("java", ref.path("origin").asText());
    }

    /**
     * The mapper names its parameter's type through a wildcard import, as a real mapper does: Spoon writes the
     * parameter bare, and the type is named by the checkout's own declaration of it.
     */
    @Test
    void anOverloadIsTakenWhenItsParameterIsImportedOnDemand() throws Exception {
        Map<String, String> sources = Map.of(
                "demo/entity/Booking.java", "package demo.entity; public class Booking { }",
                "demo/entity/Settings.java", "package demo.entity; public class Settings { }",
                "demo/mapper/Mapper.java", """
                        package demo.mapper;
                        import demo.entity.*;
                        public class Mapper {
                            public String toDto(Settings s) { return ""; }
                            public String toDto(Booking b) { return ""; }
                        }
                        """,
                "demo/Use.java", """
                        package demo;
                        import demo.entity.Booking;
                        import demo.mapper.Mapper;
                        import org.example.Page;
                        public class Use {
                            private final Mapper mapper = new Mapper();
                            Object run(Page<Booking> bookings) { return bookings.map(mapper::toDto); }
                        }
                        """);
        var run = DumpRun.of(dir, sources);
        int line = DumpRun.lineOf(sources.get("demo/Use.java"), "bookings.map(mapper::toDto)");
        JsonNode ref = run.rows("calls").stream()
                .filter(r -> "methodRef".equals(r.path("kind").asText()) && r.path("line").asInt() == line)
                .findFirst().orElseThrow();
        assertEquals("demo.mapper.Mapper#toDto(Booking)", ref.path("targets").get(0).path("id").asText());
        assertEquals("java", ref.path("origin").asText());
    }

    /** No overload takes the receiver's type argument: no target, and no guess. */
    @Test
    void anOverloadedMethodReferenceNoOverloadMatchesHasNoTarget() throws Exception {
        JsonNode ref = refOn("toDto", "names.map(mapper::toDto)");
        assertTrue(ref.path("targets").isEmpty(), "no overload takes String: the dump does not pick one");
        assertEquals("unresolved", ref.path("origin").asText());
    }
}

package mindmodel.engine.resolve;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.io.InputStream;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.Test;

/** The bundled library-signatures.json: the one declared extension to what Spoon reads from source. */
class LibraryTypesTest {

    @Test
    void bundledTableLoadsWithFacts() {
        assertTrue(LibraryTypes.size() > 0, "the table ships with at least one (type, method) fact");
    }

    @Test
    void resourceIsOnTheClasspathAndHasTypes() throws Exception {
        try (InputStream in = LibraryTypes.class.getResourceAsStream("/library-signatures.json")) {
            assertNotNull(in, "library-signatures.json must be in the jar");
            JsonNode root = new ObjectMapper().readTree(in);
            assertTrue(root.path("types").size() > 0, "the file declares types");
        }
    }

    @Test
    void chainReturnTypeIsAnsweredFromTheTable() {
        assertEquals("jakarta.jms.JMSProducer", LibraryTypes.returnType("jakarta.jms.JMSContext", "createProducer", 0));
    }
}

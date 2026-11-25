package mindmodel.engine.dump;

import static org.junit.jupiter.api.Assertions.assertEquals;

import java.nio.file.Path;
import java.util.List;
import java.util.Map;

import com.fasterxml.jackson.databind.JsonNode;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

/** files.ndjson: a file's imports as its header says them, whatever comments and byte order come before them. */
class FilesTest {

    @TempDir
    Path dir;

    private static List<String> importsOf(JsonNode row) {
        List<String> out = new java.util.ArrayList<>();
        for (JsonNode i : row.path("imports")) out.add(i.path("name").asText());
        return out;
    }

    @Test
    void byteOrderMarkBeforePackageDoesNotHideTheImports() throws Exception {
        String source = "﻿package demo;\nimport java.util.List;\npublic class Bom {}\n";

        JsonNode row = DumpRun.one(DumpRun.of(dir, Map.of("demo/Bom.java", source)).rows("files"), "path",
                "demo/Bom.java");

        assertEquals(List.of("java.util.List"), importsOf(row));
    }

    @Test
    void importsInsideABlockCommentBannerAreNotImports() throws Exception {
        String source = """
                package demo;
                /*
                import java.util.Map;
                Banner text, not code.
                */
                import java.util.List;
                public class Banner {}
                """;

        JsonNode row = DumpRun.one(DumpRun.of(dir, Map.of("demo/Banner.java", source)).rows("files"), "path",
                "demo/Banner.java");

        assertEquals(List.of("java.util.List"), importsOf(row));
    }
}

package mindmodel.engine.model;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;

import org.eclipse.jdt.core.compiler.CategorizedProblem;
import spoon.Launcher;
import spoon.compiler.Environment;
import spoon.reflect.cu.CompilationUnit;
import spoon.reflect.declaration.CtElement;
import spoon.reflect.declaration.CtType;
import spoon.support.compiler.jdt.JDTBasedSpoonCompiler;

/**
 * A Spoon model over an explicit file list: no comments, no compilation, and the project's own classpath when it reads.
 * Files are resolved through their real paths, so the paths Spoon reports match the project-relative paths the dump
 * writes (macOS /tmp is a symlink).
 */
public final class SourceModel {

    /** A model, and the classpath entry it had to drop to be built (null when it dropped none). */
    public record Load(SourceModel model, String dropped) {
    }

    private final Path root;
    private final List<String> files;
    private final Set<String> fileSet;
    private final Launcher launcher;
    private final Generated generated;

    private SourceModel(Path root, List<String> files, Launcher launcher, Generated generated) {
        this.root = root;
        this.files = files;
        this.fileSet = new HashSet<>(files);
        this.launcher = launcher;
        this.generated = generated;
    }

    /** The project's Java level: an explicit MINDMODEL_COMPLIANCE, else 17. */
    public static int compliance() {
        String env = System.getenv("MINDMODEL_COMPLIANCE");
        if (env != null && env.matches("\\d{2}")) return Integer.parseInt(env);
        return 17;
    }

    /** Normalises the file list to project-relative POSIX paths and drops anything outside the root. */
    public static List<String> relativeFiles(Path root, List<String> listed) {
        Set<String> out = new LinkedHashSet<>();
        Path realRoot = realPath(root);
        for (String raw : listed) {
            if (raw == null) continue;
            String text = raw.trim();
            if (text.isEmpty() || !text.endsWith(".java")) continue;
            Path p = realPath(realRoot.resolve(text));
            if (!p.startsWith(realRoot) || !Files.isRegularFile(p)) continue;
            out.add(realRoot.relativize(p).toString().replace('\\', '/'));
        }
        return new ArrayList<>(out);
    }

    /**
     * The model over the inputs, with the classpath when it reads. A classpath is an improvement, never a condition: a
     * jar the reader cannot take (a class file from a newer Java, a corrupt entry) is dropped, and the model is rebuilt
     * without it, exactly as it ran before. The drop is recorded in meta.json.
     */
    public static Load load(Path root, List<String> inputs, int compliance, List<String> classpath,
            List<String> generatedDirs) {
        try {
            return new Load(build(root, inputs, compliance, classpath, generatedDirs), null);
        } catch (Exception | LinkageError failure) {
            if (classpath.isEmpty()) throw failure;
            String dropped = failure.getClass().getSimpleName()
                    + (failure.getMessage() == null ? "" : ": " + failure.getMessage());
            if (dropped.length() > 200) dropped = dropped.substring(0, 200);
            return new Load(build(root, inputs, compliance, List.of(), generatedDirs), dropped);
        }
    }

    /** The model over the inputs alone: no classpath and no generated sources. */
    public static SourceModel build(Path root, List<String> relFiles, int compliance) {
        return build(root, relFiles, compliance, List.of(), List.of());
    }

    /**
     * The model with the project's own dependencies on the classpath. `noClasspath` stays true: a jar that is missing
     * or unreadable degrades to the name-only answer, never to a failed dump.
     *
     * <p>Extra source directories (annotation-processor output) are read after the project's own files, so a duplicate
     * declaration keeps the project's.
     */
    public static SourceModel build(Path root, List<String> relFiles, int compliance, List<String> classpath,
            List<String> generatedDirs) {
        Path realRoot = realPath(root);
        Launcher launcher = new Launcher();
        Environment env = launcher.getEnvironment();
        env.setNoClasspath(true);
        env.setCommentEnabled(false);
        env.setShouldCompile(false);
        env.setIgnoreDuplicateDeclarations(true);
        env.setComplianceLevel(compliance);
        env.setAutoImports(false);
        env.setCopyResources(false);
        env.setLevel("OFF");
        if (!classpath.isEmpty()) env.setSourceClasspath(classpath.toArray(new String[0]));
        for (String rel : relFiles) launcher.addInputResource(realRoot.resolve(rel).toString());
        List<String> roots = new ArrayList<>();
        for (String dir : generatedDirs) {
            Path at = realRoot.resolve(dir);
            if (!Files.isDirectory(at)) continue;
            launcher.addInputResource(at.toString());
            roots.add(realPath(at).toString());
        }
        launcher.buildModel();
        return new SourceModel(realRoot, List.copyOf(relFiles), launcher, new Generated(List.copyOf(roots)));
    }

    public Path root() {
        return root;
    }

    /** The project-relative input files this model was built over, in the order given. */
    public List<String> files() {
        return files;
    }

    public List<String> generatedDirs() {
        return generated.dirs();
    }

    /** True when Spoon read this element from a generated source: in the model, never a row in the dump. */
    public boolean isGenerated(CtElement element) {
        return generated.isElement(element);
    }

    /** True when a file was read from a generated root rather than as project source. */
    public boolean isGeneratedFile(Path file) {
        return generated.isFile(file);
    }

    /** The generated files Spoon read: what the dump says it looked at and wrote nothing about. */
    public int generatedFiles() {
        if (generated.dirs().isEmpty()) return 0;
        int out = 0;
        for (String unit : launcher.getFactory().CompilationUnit().getMap().keySet())
            if (generated.isFile(Path.of(unit))) out++;
        return out;
    }

    public List<CtType<?>> allTypes() {
        return new ArrayList<>(launcher.getModel().getAllTypes());
    }

    /**
     * The compilation units of the input files, by project-relative path, in Spoon's own order. A unit of any other
     * file (a generated source, a file outside the root) is not among them.
     */
    public Map<String, CompilationUnit> units() {
        Map<String, CompilationUnit> out = new LinkedHashMap<>();
        for (var unit : launcher.getFactory().CompilationUnit().getMap().entrySet()) {
            String rel = relative(Path.of(unit.getKey()));
            if (rel != null) out.put(rel, unit.getValue());
        }
        return out;
    }

    /** Each input file's own package: {@code ""} for the default package. A file with no type still has one. */
    public Map<String, String> packages() {
        Map<String, String> out = new LinkedHashMap<>();
        for (var unit : units().entrySet()) {
            var declared = unit.getValue().getPackageDeclaration();
            out.put(unit.getKey(), declared == null || declared.getReference() == null ? ""
                    : declared.getReference().getQualifiedName());
        }
        return out;
    }

    /** Parse problems JDT reported, so the dump can name a file it could not read instead of dropping it silently. */
    public List<CategorizedProblem> problems() {
        List<CategorizedProblem> out = new ArrayList<>();
        if (!(launcher.getModelBuilder() instanceof JDTBasedSpoonCompiler compiler)) return out;
        for (CategorizedProblem p : compiler.getProblems())
            if (p.isError()) out.add(p);
        return out;
    }

    /** Project-relative name of a file under this root, or null when it is outside it or not one of the inputs. */
    private String relative(Path file) {
        Path p = realPath(file);
        if (!p.startsWith(root)) return null;
        String rel = root.relativize(p).toString().replace('\\', '/');
        return fileSet.contains(rel) ? rel : null;
    }

    /** The real path of a file, or its absolute normal form when it does not exist. */
    public static Path realPath(Path p) {
        try {
            return p.toRealPath();
        } catch (IOException e) {
            return p.toAbsolutePath().normalize();
        }
    }
}

package generic;

public interface Repo<T> {
    void save(T row);
}

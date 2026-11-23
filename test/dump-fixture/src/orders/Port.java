package orders;

import java.util.List;

public interface Port<T> {
    List<T> findAll();
    <R> R map(T value, java.util.function.Function<T, R> fn);
}

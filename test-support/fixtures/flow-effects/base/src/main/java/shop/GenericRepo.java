package shop;

import org.springframework.data.jpa.repository.JpaRepository;

public interface GenericRepo<T> extends JpaRepository<T, Long> {
}

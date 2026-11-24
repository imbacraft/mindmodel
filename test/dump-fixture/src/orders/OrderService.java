package orders;

import java.math.BigDecimal;

/** Entity setters reached through a repository: the receiver's type comes from the repository's return type. */
public class OrderService {
    private final OrderRepository repository;

    public OrderService(OrderRepository repository) {
        this.repository = repository;
    }

    public void mark(Long id) {
        Order order = repository.find(id);
        order.setTotal(BigDecimal.ONE);
    }

    public void rename(Long id, String name) {
        repository.find(id).setId(id);
    }
}

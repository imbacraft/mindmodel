package rank;

import org.springframework.stereotype.Service;

@Service
public class OrderService {
    private final OrderRepo repo;

    public OrderService(OrderRepo repo) {
        this.repo = repo;
    }

    public void create(Order o) {
        repo.save(o);
    }

    public void markPaid(Long id) {
        Order o = repo.findById(id).orElseThrow();
        o.setStatus(OrderStatus.PAID);
        repo.save(o);
    }
}

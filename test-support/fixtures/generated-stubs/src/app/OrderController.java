package app;

import gen.api.OrderApi;
import org.springframework.web.bind.annotation.RestController;

/** A contract-first controller: its three mappings are inherited from the generated interface, not written here. */
@RestController
public class OrderController implements OrderApi {

    @Override
    public Object list() {
        return null;
    }

    @Override
    public Object one(Long id) {
        return null;
    }

    @Override
    public Object create(Object body) {
        return null;
    }
}
